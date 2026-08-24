# Contract spike: Encore `AudioEncode` filters/params for a loudness-normalisation profile

Issue: [#383](https://github.com/Eyevinn/open-videocore/issues/383) — *verify Encore
AudioEncode exposes filters and params against the live service schema before building
the loudness profile*

Status: **Contract VERIFIED against upstream source.** Live end-to-end proof is
**BLOCKED / deferred** (0 Encore instances provisioned for this workspace — see the
"Live verification" section below).

This spike exists to satisfy CLAUDE.md rule #7 (*fetch the contract before writing any
call*). It records the exact profile field, its type, the ffmpeg filter-string form, the
served-profile mapping, and every citation, so the loudness-normalisation feature work
can proceed on a verified shape rather than an assumed one.

---

## 1. Why the OSC catalog schema is NOT the authoritative source here

The OSC catalog (`get-service-schema encore`) describes the *deployment/config* shape of
an Encore service instance — it does **not** describe the transcode-profile
(`EncodingProfile` / `AudioEncode`) shape. The transcode profile is opaque YAML loaded by
the Encore process at job time; the OSC-facing job API selects a profile by **name only**
and never carries the audio-encode filter shape.

Confirmed in-repo:

- `src/pipeline/encore-client.ts:73-97` — `toEncorePayload` note:
  "Encore's API schema has NO top-level `outputs` field. Profiles are server-side named
  configurations — the profile name string is the only way to select a ladder."
  `profileParams` is verified as `EncoreJob.profileParams: Map<String, Any?>`
  (SpEL), citing `github.com/svt/encore`.

Because the job body cannot carry the filter shape and the OSC schema does not describe
the profile, **the authoritative contract for `filters`/`params` is SVT Encore's own
profile model** — the same upstream project already cited in `encore-client.ts`.

An OSC friction note has been logged for the schema/instance gap:
`docs/osc-feedback/incoming-encore-no-instance-loudnorm-spike.md` (in the agents repo
`eng-open-videocore-agents`, i.e. `/usercontent/docs/osc-feedback/…`).

---

## 2. Verified field path + type (authoritative upstream contract)

Source: `svt/encore`, file
`encore-common/src/main/kotlin/se/svt/oss/encore/model/profile/AudioEncode.kt`
(latest commit for that file: `4e01ab9c34d8cbee4cc0c58e76d103dc3f12f23a`).
Raw: <https://raw.githubusercontent.com/svt/encore/master/encore-common/src/main/kotlin/se/svt/oss/encore/model/profile/AudioEncode.kt>

```kotlin
data class AudioEncode(
    val codec: String = "aac",
    val bitrate: String? = null,
    val samplerate: Int = 48000,
    val channelLayout: ChannelLayout = ChannelLayout.CH_LAYOUT_STEREO,
    val suffix: String = "_${codec}_${channelLayout.layoutName}",
    val params: LinkedHashMap<String, String> = linkedMapOf(),   // <-- ffmpeg output params
    val filters: List<String> = Collections.emptyList(),          // <-- free-form ffmpeg audio filters
    ...
) : AudioEncoder()
```

Verified answers to the issue's questions:

| Question | Verified answer | Citation |
|----------|-----------------|----------|
| Field name for the free-form ffmpeg audio filter chain | **`filters`** | `AudioEncode.kt`, field declaration |
| Type of `filters` | **`List<String>`** (default `Collections.emptyList()`) | `AudioEncode.kt` |
| Field for extra ffmpeg output params | **`params`** | `AudioEncode.kt` |
| Type of `params` | **`LinkedHashMap<String, String>`** (default empty) | `AudioEncode.kt` |
| Does the claim `filters: []` + `params: {}` hold? | **Yes**, exactly as claimed — both exist, both default to empty | `AudioEncode.kt` |

### How `filters` reaches ffmpeg

`AudioEncode.getOutput(...)` builds the ffmpeg filter argument for the audio stream by
concatenating dialogue-enhancement filters, channel-mix filters, and the profile's own
`filters` with commas:

```kotlin
filter = (dialogueEnhanceFilters + mixFilters + filters).joinToString(",").ifEmpty { null }
```

(same file, inside `getOutput`). So each string element of `filters` is inserted verbatim
into the ffmpeg audio filter chain — confirming that a `loudnorm=…` element reaches
ffmpeg as a filter.

### Exact `loudnorm` filter string form

`loudnorm` is a single element of the `filters` list. In profile YAML:

```yaml
filters:
  - loudnorm=I=-23:TP=-1:LRA=7
```

This becomes part of the comma-joined ffmpeg `-filter`/`-af` chain for that audio output.
(EBU R128 example values shown; `I` = integrated loudness target, `TP` = true-peak,
`LRA` = loudness range — standard ffmpeg `loudnorm` parameters. The exact target values
are a feature-work decision, out of scope for this contract spike.)

---

## 3. Where `AudioEncode` sits in a profile (the full YAML path)

An `AudioEncode` is one entry in a profile's `encodes` list, discriminated by a Jackson
polymorphic `type` field.

- `Profile.encodes: List<OutputProducer>` — `Profile.kt`
  (<https://raw.githubusercontent.com/svt/encore/master/encore-common/src/main/kotlin/se/svt/oss/encore/model/profile/Profile.kt>)
- The `type` discriminator: `@JsonTypeInfo(use = Id.NAME, property = "type")` registers
  `AudioEncode::class` as name `"AudioEncode"` — `OutputProducer.kt`
  (<https://raw.githubusercontent.com/svt/encore/master/encore-common/src/main/kotlin/se/svt/oss/encore/model/profile/OutputProducer.kt>)

**Verified YAML path:** `encodes[] where type == "AudioEncode"  ->  .filters[]`
(and `.params{}`).

Minimal profile fragment proven consistent with the upstream example profile
`encore-web/src/test/resources/profile/program.yml` (which uses the same
`encodes: - type: … params: …` structure):

```yaml
name: loudnorm-spike
description: Throwaway profile to prove a loudnorm filter reaches ffmpeg
encodes:
  - type: AudioEncode
    codec: aac
    bitrate: 128k
    filters:
      - loudnorm=I=-23:TP=-1:LRA=7
```

---

## 4. Served-profile → Encore mapping (in-repo)

Our API stores each profile as opaque YAML and serves it in the Encore-native index
format. Encore fetches the index, then fetches each named profile document.

- `src/routes/profiles.ts:128-150` — `GET /index.yml` builds the Encore index as
  `"<name>: <name>/yaml"` lines. Served unauthenticated (`text/yaml`) so Encore
  instances can fetch it without a bearer token.
- `src/routes/profiles.ts:219-235` — `GET /:name/yaml` returns the raw profile YAML as
  `text/yaml`. This is the document whose body is the `Profile`/`AudioEncode` shape
  above; the repo treats it as an opaque string.
- `src/pipeline/encore-client.ts:81-97` — `toEncorePayload` submits the job selecting the
  profile by **name** (`profile: input.profile`); the filter shape is *not* in the job
  body — it lives entirely in the served YAML.

So the chain is:
**stored profile YAML** → `GET /index.yml` (name → `name/yaml`) → Encore fetches
`GET /:name/yaml` → Encore parses it as `Profile` with `encodes[].type=AudioEncode` →
the `filters` list is applied to ffmpeg. A loudness profile is therefore delivered purely
as YAML content under an existing profile name; no API/job-payload change is required.

---

## 5. Live verification: BLOCKED — deferred

**0 Encore instances are provisioned for this workspace** (verified via OSC
`list-service-instances` for serviceId `encore`: "0 instances running"). The second
acceptance bullet of #383 — *prove a `loudnorm` filter reaches ffmpeg on a **live**
Encore instance* — therefore **cannot be satisfied in this environment** and is
explicitly deferred. No live run has been fabricated.

Friction logged: `/usercontent/docs/osc-feedback/incoming-encore-no-instance-loudnorm-spike.md`.

### Exact live test to run once an Encore instance exists

1. Provision an Encore service instance (OSC `create-service-instance` for serviceId
   `encore`); point its profiles index at this API's `GET /index.yml`.
2. Create a throwaway profile via `POST /profiles` with body
   `{ name: "loudnorm-spike", yaml: <the section-3 fragment> }`.
3. Confirm it is served: `GET /index.yml` lists `loudnorm-spike: loudnorm-spike/yaml`,
   and `GET /loudnorm-spike/yaml` returns the YAML verbatim.
4. Submit a job selecting `profile: "loudnorm-spike"` (via `toEncorePayload`) against a
   short test input that has an audio stream.
5. Prove the filter reached ffmpeg by **either**:
   - inspecting the Encore job/worker logs for the ffmpeg command line and confirming
     `loudnorm=I=-23:TP=-1:LRA=7` appears in the audio filter chain, **or**
   - measuring the output: run `ffmpeg -i <output> -af loudnorm=print_format=json -f null -`
     and confirm the measured integrated loudness matches the requested target
     (≈ `-23 LUFS`) rather than the untreated source loudness.
6. Delete the throwaway profile (`DELETE /loudnorm-spike`).

---

## 6. Citations (complete)

In-repo (`Eyevinn/open-videocore`, branch `issue-383/verify-audioencode-loudnorm`):

- `src/pipeline/encore-client.ts:73-97` — no `outputs` field; profile selected by name;
  `profileParams` shape.
- `src/routes/profiles.ts:128-150` — `GET /index.yml` name→`name/yaml` mapping.
- `src/routes/profiles.ts:219-235` — `GET /:name/yaml` raw YAML serving.

Upstream (`svt/encore`):

- `encore-common/src/main/kotlin/se/svt/oss/encore/model/profile/AudioEncode.kt`
  — `filters: List<String>`, `params: LinkedHashMap<String, String>`, and the
  `(… + filters).joinToString(",")` filter assembly. File commit
  `4e01ab9c34d8cbee4cc0c58e76d103dc3f12f23a`.
- `encore-common/src/main/kotlin/se/svt/oss/encore/model/profile/Profile.kt`
  — `encodes: List<OutputProducer>`.
- `encore-common/src/main/kotlin/se/svt/oss/encore/model/profile/OutputProducer.kt`
  — Jackson `type` discriminator registering `AudioEncode`.
- `encore-web/src/test/resources/profile/program.yml` — reference profile confirming the
  `encodes: - type: … params: …` YAML structure.
