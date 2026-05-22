import { readdir, readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { marked } from "marked";
import matter from "gray-matter";

type Post = {
  slug: string;
  title: string;
  date: string;
  description: string;
  html: string;
};

type Page = {
  slug: string;
  title: string;
  description: string;
  html: string;
};

const ROOT = path.resolve(".");
const POSTS_DIR = path.join(ROOT, "posts");
const PAGES_DIR = path.join(ROOT, "pages");
const TEMPLATES_DIR = path.join(ROOT, "templates");
const PUBLIC_DIR = path.join(ROOT, "public");
const OUT_DIR = path.join(ROOT, "dist");

const SITE = {
  title: "Martin's Thoughts",
  description: "Thoughts and writings by Martin-Zack Mekkaoui.",
  url: "https://mekkaoui.fr",
  author: "Martin-Zack Mekkaoui",
};

marked.setOptions({ gfm: true, breaks: false });

function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) =>
    vars[key] === undefined ? "" : String(vars[key]),
  );
}

function slugify(name: string): string {
  return name.replace(/\.md$/i, "").toLowerCase();
}

function formatDate(d: unknown): string {
  const date = d instanceof Date ? d : new Date(String(d));
  return date.toISOString().slice(0, 10);
}

function escapeHtml(s: string): string {
  return String(s).replace(/[<>&"']/g, (c) => {
    const map: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[c]!;
  });
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatDateLong(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m! - 1]} ${d}, ${y}`;
}

function escapeXml(s: string): string {
  return String(s).replace(/[<>&'"]/g, (c) => {
    const map: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      '"': "&quot;",
    };
    return map[c]!;
  });
}

async function loadPosts(): Promise<Post[]> {
  const files = (await readdir(POSTS_DIR)).filter((f) => f.endsWith(".md"));
  const posts = await Promise.all(
    files.map(async (file): Promise<Post> => {
      const raw = await readFile(path.join(POSTS_DIR, file), "utf8");
      const { data, content } = matter(raw);
      if (!data.title) throw new Error(`${file}: missing 'title' in frontmatter`);
      if (!data.date) throw new Error(`${file}: missing 'date' in frontmatter`);
      return {
        slug: (data.slug as string | undefined) || slugify(file),
        title: String(data.title),
        date: formatDate(data.date),
        description: (data.description as string | undefined) || "",
        html: await marked.parse(content),
      };
    }),
  );
  posts.sort((a, b) => (a.date < b.date ? 1 : -1));
  return posts;
}

async function loadPages(): Promise<Page[]> {
  if (!existsSync(PAGES_DIR)) return [];
  const files = (await readdir(PAGES_DIR)).filter((f) => f.endsWith(".md"));
  return Promise.all(
    files.map(async (file): Promise<Page> => {
      const raw = await readFile(path.join(PAGES_DIR, file), "utf8");
      const { data, content } = matter(raw);
      if (!data.title) throw new Error(`${file}: missing 'title' in frontmatter`);
      return {
        slug: (data.slug as string | undefined) || slugify(file),
        title: String(data.title),
        description: (data.description as string | undefined) || "",
        html: await marked.parse(content),
      };
    }),
  );
}

async function build(): Promise<void> {
  if (existsSync(OUT_DIR)) await rm(OUT_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const layout = await readFile(path.join(TEMPLATES_DIR, "layout.html"), "utf8");
  const postTpl = await readFile(path.join(TEMPLATES_DIR, "post.html"), "utf8");
  const pageTpl = await readFile(path.join(TEMPLATES_DIR, "page.html"), "utf8");
  const indexTpl = await readFile(path.join(TEMPLATES_DIR, "index.html"), "utf8");

  if (existsSync(PUBLIC_DIR)) {
    await cp(PUBLIC_DIR, OUT_DIR, { recursive: true });
  }

  await writeFile(path.join(OUT_DIR, "CNAME"), "mekkaoui.fr\n");
  await writeFile(path.join(OUT_DIR, ".nojekyll"), "");

  const posts = await loadPosts();
  const pages = await loadPages();
  const year = new Date().getUTCFullYear();

  for (const page of pages) {
    const body = render(pageTpl, page);
    const out = render(layout, {
      title: `${page.title} — ${SITE.title}`,
      description: page.description || SITE.description,
      site_title: SITE.title,
      site_url: SITE.url,
      url: `${SITE.url}/${page.slug}/`,
      og_type: "website",
      og_extra: "",
      content: body,
      year,
    });
    const dir = path.join(OUT_DIR, page.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), out);
  }

  for (const post of posts) {
    const body = render(postTpl, post);
    const articleMeta = [
      `<meta property="article:published_time" content="${post.date}" />`,
      `<meta property="article:author" content="${escapeHtml(SITE.author)}" />`,
    ].join("\n    ");
    const page = render(layout, {
      title: `${post.title} — ${SITE.title}`,
      description: post.description || SITE.description,
      site_title: SITE.title,
      site_url: SITE.url,
      url: `${SITE.url}/${post.slug}/`,
      og_type: "article",
      og_extra: articleMeta,
      content: body,
      year,
    });
    const dir = path.join(OUT_DIR, post.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), page);
  }

  const list = posts
    .map(
      (p) => `<li class="post">
      <a class="post-title" href="/${p.slug}/">${escapeHtml(p.title)}</a>
      <p class="post-meta"><time datetime="${p.date}">${formatDateLong(p.date)}</time>${
        p.description ? ` &middot; ${escapeHtml(p.description)}` : ""
      }</p>
    </li>`,
    )
    .join("\n");
  const indexBody = render(indexTpl, { posts: list });
  const indexPage = render(layout, {
    title: SITE.title,
    description: SITE.description,
    site_title: SITE.title,
    site_url: SITE.url,
    url: `${SITE.url}/`,
    og_type: "website",
    og_extra: "",
    content: indexBody,
    year,
  });
  await writeFile(path.join(OUT_DIR, "index.html"), indexPage);

  const feedItems = posts
    .map(
      (p) => `  <entry>
    <title>${escapeXml(p.title)}</title>
    <link href="${SITE.url}/${p.slug}/"/>
    <id>${SITE.url}/${p.slug}/</id>
    <updated>${new Date(p.date).toISOString()}</updated>
    <summary>${escapeXml(p.description)}</summary>
  </entry>`,
    )
    .join("\n");
  const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(SITE.title)}</title>
  <link href="${SITE.url}/"/>
  <id>${SITE.url}/</id>
  <updated>${new Date().toISOString()}</updated>
  <author><name>${escapeXml(SITE.author)}</name></author>
${feedItems}
</feed>
`;
  await writeFile(path.join(OUT_DIR, "feed.xml"), feed);

  console.log(
    `Built ${posts.length} post(s), ${pages.length} page(s) → ${path.relative(ROOT, OUT_DIR)}/`,
  );
}

await build();
