# Signal Lab

Real-time audio signal processing visualizer. Generate waveforms, chain effects, and see + hear the results.

## Local Development

```bash
npm install
npm run dev
```

## Deploy to GitHub Pages

Deployment happens automatically when you push to `main`. See `.github/workflows/deploy.yml`.

**First-time setup:**
1. Create a GitHub repo (e.g. `signal-lab`)
2. Update the `base` path in `vite.config.js` to match your repo name
3. Push your code to `main`
4. Go to repo **Settings → Pages → Source** and select **GitHub Actions**
5. The workflow runs automatically and your site goes live at `https://<username>.github.io/signal-lab/`
