# Can an ffmpeg-s3 job hand us the scene-cut timestamps? (issue #1191)

- Date: 2026-10-14
- Issue: #1191 (spike) — blocks the detector rewrite
- Service: `eyevinn-ffmpeg-s3` (`src/services/stack.ts:79` `FFPROBE_SERVICE_ID`)
- Contract pinned by this spike: `docs/contracts/eyevinn-ffmpeg-s3-job-and-logs.json`
  (`Eyevinn/ffmpeg-s3` @ `95ede50d3486cc4b2145871af08a4138ba5e3b9d`, `main` HEAD on 2026-10-14)

## What this spike could and could not do

No OSC credential or OSC tool surface was available in the environment this spike ran
in, so **no job was created and no `/logs/:name` response was captured**. Nothing below
is a live observation. What it is instead: the service's own source, fetched at a pinned
commit, which turns out to answer the spike's central question more definitively than a
single live run would have — and to leave two sub-questions that only a live run can
close. Those are marked **LIVE RUN REQUIRED** and are listed again at the end.

## The short answer

**Do not build the detector on the log route.** On a job whose ffmpeg exits 0, the log
contains no ffmpeg output at all — not the `showinfo` lines, not the stream dump, nothing.
That is not a quirk of a particular video; it is one missing option in the service:

```ts
// Eyevinn/ffmpeg-s3 src/ffmpeg.ts:224-235
const { status, stderr, error } = spawnSync(ffmpeg, args, { cwd: stagingDir });
if (status !== 0) {
  if (error) { console.error(`FFmpeg failed: ${error.message}`); }
  else { console.error(`FFmpeg failed with exit code ${status}`);
         console.error(stderr.toString()); }       // <- the ONLY path to the log
  throw new Error('FFmpeg failed');
}
```

`spawnSync` is called with no `stdio` option, so the default `'pipe'` applies: ffmpeg's
stderr is captured into a buffer rather than inherited by the container. That buffer is
written to the container log by exactly one statement, and that statement sits inside
`if (status !== 0)`. `showinfo` prints `pts_time=` to stderr. So:

- ffmpeg exits non-zero → the entire stderr buffer lands in the log in one go.
- ffmpeg exits **zero** → the buffer is dropped and the log holds only the wrapper's own
  `console.log` lines (`Output file:`, `Staging directory:`, `Actual command string:`,
  `cmdString:`, and `Uploaded <dest>`).

So the spike's question 1 — "are showinfo lines present in the log of a job that finishes
successfully, not only a failed one?" — is answered **no, by construction**.

## The uncomfortable part: our existing probe reads the log only because its ffmpeg fails

`src/pipeline/osc-ffprobe.ts` parses the stream dump out of the job log and works in
production. Given the above, it can only be reading the `status !== 0` branch. It is:

`ffprobeCmdLine` (`src/pipeline/osc-ffprobe.ts:45-47`) sends `-i "<url>" -f null -`.
The service's command rewriter picks the output as the last argument that does not start
with `-` (`src/ffmpeg.ts:90-99`); the trailing `-` is skipped as a flag, so the "output"
it detects is the literal string **`null`**. It then does a first-occurrence substring
replace of that output with a staging path (`src/ffmpeg.ts:171-190`), so `-f null -`
reaches ffmpeg as `-f /usercontent/<jobid>/null -` — not a muxer name. ffmpeg has already
opened and dumped the input by the time it rejects the output format, so the dump is in
stderr, the exit is non-zero, `console.error(stderr)` fires, and the parse succeeds.
`src/cli.ts:7-19` then swallows the thrown error (`catch { console.log(err.message) }`,
no non-zero exit), so the container exits 0 and the job still reports a success status —
the same mechanism already logged for #786.

That chain is load-bearing for metadata extraction today and nobody wrote it down. It is
also fragile in a specific way: the pinned HEAD commit is literally a fix to the output
rewrite ("prevent S3 output path from being presigned before local staging replacement"),
and one more fix in that area makes `-f null -` succeed, which would **silently empty the
log our probe parses**. Worth its own issue; out of scope here.

A scene-cut reader built the same way would inherit that fragility and add a second
problem: it would have to treat "ffmpeg failed" as its happy path, which means it could
never distinguish a real failure from its own normal operation.

## The fallback, and the shape of it that actually works

The issue asks whether ffmpeg can write the metadata to an S3 object via the native S3
writer the other ffmpeg-s3 jobs use (`src/main.ts:856` and the runners it wires —
`osc-thumbnail.ts:71-74`, `osc-rewrap.ts:130-133`, `osc-clip.ts:144-152`). **Yes, with
one constraint that rules out the obvious implementation.**

The uploader's single-file S3 branch reads the staging directory and uploads **only** the
file whose basename equals the destination basename (`src/ffmpeg.ts:337-345`):

```ts
const files = await readdir(stagingDir);
const file = files.find((f) => f === fileName);   // fileName = basename(dest.pathname)
```

So a sidecar — `-vf "select='gt(scene,0.4)',metadata=print:file=scenes.txt"` — is written
into the staging directory (ffmpeg runs with `cwd: stagingDir`) and then **left there**.
It never reaches S3 on this branch. Two ways out:

1. **Make the cut list the muxer output itself**, so the single-file branch applies
   unchanged. `-f framemd5` writes one line per frame reaching the muxer, with the pts in
   the stream timebase and a `#tb` header to scale it; put `select` upstream of it and the
   only frames reaching the muxer are the cuts:

   ```
   -i s3://<bucket>/<key> -an -fps_mode passthrough \
     -vf "select='gt(scene,0.4)'" \
     -f framemd5 s3://<bucket>/<prefix>/<id>.framemd5
   ```

   This is the recommended shape. It needs no sidecar, no directory upload, and ffmpeg
   exits 0 — which matters, because `uploadResult` is only reached if `runFFmpeg` did not
   throw (`src/ffmpeg.ts:28-29`).

2. **Use the recursive branch** by ending the destination in `/`
   (`src/ffmpeg.ts:318-335`), which `aws s3 cp --recursive`s the whole staging directory
   and so does carry a `metadata=print` sidecar. Two warts: the destination is
   `dirname()` of an already-trailing-slash path, so `s3://bucket/a/b/` uploads to
   `s3://bucket/a/`; and ffmpeg still has to write its own output, to
   `<stagingDir>/b`. Workable, messier, and it uploads whatever else the job left behind.

Either way the credentials travel in the job body as they already do for the other three
runners: `cmdLineArgs`, `awsAccessKeyId`, `awsSecretAccessKey`, `s3EndpointUrl` — the four
fields confirmed by the service's own readme (`readme.md:43-47`), recorded in the pinned
snapshot. (`awsRegion` / `awsSessionToken`, which `osc-ffprobe.ts:177-178` also sends, are
*not* named by any upstream source at this commit; they are recorded as
accepted-but-unpinned.)

## Log volume, and why it is a smaller worry than the issue assumed

Spike question 2 asks at what size the log truncates. Two things to separate:

- **Our side** is already bounded and documented: `src/pipeline/osc-job-log.ts`
  `MAX_LOG_CHARS = 4000`, keeping the **last** 4000 characters. `osc-ffprobe.ts` applies
  no cap of its own.
- **The platform side** — whether `/logs/:name` truncates, pages, or ring-buffers, and at
  what size — has no published contract and was not measured here. **LIVE RUN REQUIRED.**

Worth noting for whoever runs it: with `select` placed *before* `showinfo`, only the
selected frames are printed, so the line count scales with the number of cuts, not with
the duration of the video. A 90-minute film with 600 cuts produces ~600 lines of maybe
200 bytes each — ~120 KB, and that is the pessimistic end. The 4000-character cap on our
side would mangle that long before any plausible platform limit did. But since the log
route is not the recommended path anyway, this matters mainly for the existing probe.

## Acceptance criteria — status

The issue accepts **either** "the log route is confirmed to carry the cuts on a successful
job, with the snapshot pinned" **or** "the fallback is confirmed instead".

- Log route: **settled, negative.** Confirmed from the service's source at a pinned
  commit, not from a run — and the source is unambiguous (`src/ffmpeg.ts:224-235`). The
  snapshot is pinned at `docs/contracts/eyevinn-ffmpeg-s3-job-and-logs.json`.
- Fallback: **confirmed as supported by the uploader**, with the constraint above read out
  of `src/ffmpeg.ts:337-345`, and with the exact command shape recommended. Not yet
  executed.

So the detector rewrite is unblocked on its **design** decision: write the cuts to an S3
object, do not scrape the log. It is not yet unblocked on implementation certainty.

### LIVE RUN REQUIRED (on an OSC-enabled agent)

1. That the `framemd5`-to-S3 shape above completes and the object appears — including that
   the published image's Alpine ffmpeg (`Dockerfile:13`, a distro package, so its muxer
   set is not pinned by anything) has the `framemd5` muxer, and that the output rewrite
   (`src/ffmpeg.ts:190`, a first-occurrence substring replace) does not mangle the s3
   output for this command.
2. The platform-side log truncation/paging threshold for `/logs/:name`.
3. Cheap confirmation of the negative result: run any job that exits 0 (e.g. the existing
   re-wrap) and check the log holds only the wrapper's `console.log` lines.
4. Whether `/logs/:name` returns the container's stderr as well as its stdout. The
   existing probe working in production implies yes for `console.error`, but no capture is
   recorded in this repo.

OSC friction logged in the agents repo:
`docs/osc-feedback/incoming-ffmpeg-s3-job-log-discards-ffmpeg-stderr-on-success.md`.
