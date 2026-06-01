# open-videocore — Data Pipeline

Ingest and processing pipeline for open-videocore.

## Responsibilities

- **Watch-folder trigger** — listen to MinIO bucket events and queue ingest jobs
- **URL-pull ingest** — fetch remote media files into MinIO storage
- **Transcoding orchestration** — submit jobs to Encore and track progress via Encore Callback Listener
- **Metadata extraction** — spawn `eyevinn-ffmpeg-s3` instances for technical probing and thumbnail generation
- **AI/ML pipeline stages** — optional `eyevinn-auto-subtitles` for speech-to-text (requires OpenAI key)

## Status

Skeleton — implementation forthcoming. See ADR-001 for service selection rationale.
