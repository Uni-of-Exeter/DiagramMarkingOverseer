# Marking Overseer

AI-assisted marking for paper-based mathematics assessments.

## Setup

```sh
git clone <repo-url>
cd DiagramMarkingOverseer
pip install -r MarkingOverseer/requirements.txt
python MarkingOverseer/app.py
```

Open http://127.0.0.1:5001

## Configuration

Click **Config** in the sidebar to set:

- **Data Root** — folder containing `body/` and `header/` scan subdirectories
- **Answer Sheets Root** — optional folder with model-answer PDFs
- **AWS credentials** — profile and region for Bedrock models

Marking attempts, overrides, and student data are saved to
`<git-repo-parent>/MarkingOverseer/` by default (configurable via *Overseer Data Root*).

## Pipeline

1. **Extract Student IDs** — reads handwritten identifiers from header scans
2. **Extract Question IDs** — reads printed QID codes from body scans
3. **Extract TA Marks** — reads teaching-assistant pass/fail marks from headers
4. **AI Marking** — runs one or more AI models across body PDFs

## AWS SSO

If using AWS Bedrock with an SSO profile, run `aws sso login --profile <profile>` before
starting, or click **Test AWS credentials** in Config to trigger the SSO login flow.
