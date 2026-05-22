# Martin's Thoughts

My blog at [mekkaoui.fr](https://mekkaoui.fr).

## About

Tiny markdown blog. `posts/*.md` → `dist/*.html` via a small TypeScript script (`build.ts`), no SSG framework. Hosted on GitHub Pages with a custom apex domain.

## Layout

- **Posts**: `posts/YYYY-MM-DD-slug.md` with `title`, `date`, optional `description` frontmatter
- **Templates**: `templates/` — `layout.html`, `post.html`, `index.html`, `{{var}}` substitution only
- **Static assets**: `public/` is copied verbatim into `dist/`
- **Build**: `build.ts` (run via `tsx`)
- **Deploy**: `.github/workflows/deploy.yml` publishes `dist/` to GitHub Pages on push to `main`

## Development

```bash
npm install
npm run build       # write dist/
npm run serve       # http://localhost:8000
npm run typecheck
```

## Custom domain (one-time)

1. **Repo Settings → Pages** → Source: *GitHub Actions*.
2. **Repo Settings → Pages → Custom domain** → `mekkaoui.fr`. Tick *Enforce HTTPS* once the cert provisions.
3. **DNS** at your registrar for `mekkaoui.fr`:

   ```
   A     @     185.199.108.153
   A     @     185.199.109.153
   A     @     185.199.110.153
   A     @     185.199.111.153
   AAAA  @     2606:50c0:8000::153
   AAAA  @     2606:50c0:8001::153
   AAAA  @     2606:50c0:8002::153
   AAAA  @     2606:50c0:8003::153
   CNAME www   <github-username>.github.io.
   ```

The build writes `CNAME` and `.nojekyll` into `dist/` automatically.
