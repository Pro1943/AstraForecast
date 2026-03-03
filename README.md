# AstraForecast Frontend

Static frontend repo for Netlify.

## Pages

- `index.html` - interactive dashboard
- `why-this-matters.html` - policy context and sustainability framing
- `model-limitations.html` - transparent model limitations
- `about-creator.html` - creator profile section

## Assets

- `assets/logo.svg` - navbar logo (click returns home)
- `assets/favicon.svg` - browser icon

## Why this matters

The dashboard references the Kessler Syndrome concept (named after Donald J. Kessler) to explain how delayed intervention can amplify orbital debris risk and long-term sustainability costs.

## Data transparency notes

- Dataset source: project CSV (`backend/datasets/space_launches.csv`)
- Coverage: starts at year 2000, extends through latest dataset year
- Preprocessing: schema filtering, sort by year, cumulative aggregation
- Modeling rationale: polynomial degree-2 trend is used for policy-support forecasting to avoid aggressive long-run exponential overshoot on limited data.

## Run locally

```bash
python -m http.server 8000
```

Open `http://localhost:8000`.

## Backend connection

The frontend attempts API first (`/predict` on same origin), then falls back to static `predictions.json`.

For cross-domain backend:

```text
https://<your-netlify-site>.netlify.app/?api=https://<your-vercel-backend>.vercel.app
```

The API base URL is stored in browser local storage.

## Deploy on Netlify

1. Push `frontend/` as its own repo.
2. Import into Netlify.
3. Publish directory: `.`
4. Deploy.
