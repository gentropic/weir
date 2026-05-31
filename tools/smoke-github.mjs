// GitHub adapter tests (no network). Run: node tools/smoke-github.mjs
import assert from 'node:assert';
import { githubFeedUrl, githubName, parseGithub, githubAdapter } from '../src/js/adapters/github.js';

// ── URL resolution (pure string, no fetch) ──
assert.equal(githubFeedUrl('https://github.com/octocat/Hello-World'), 'https://github.com/octocat/Hello-World/releases.atom', 'repo → releases by default');
assert.equal(githubFeedUrl('github.com/octocat/Hello-World/commits'), 'https://github.com/octocat/Hello-World/commits.atom', 'commits path');
assert.equal(githubFeedUrl('https://github.com/octocat/Hello-World/tags'), 'https://github.com/octocat/Hello-World/tags.atom', 'tags path');
assert.equal(githubFeedUrl('https://github.com/octocat/Hello-World.git'), 'https://github.com/octocat/Hello-World/releases.atom', 'strips .git');
assert.equal(githubFeedUrl('https://github.com/octocat'), 'https://github.com/octocat.atom', 'bare user → activity feed');
assert.equal(githubFeedUrl('https://github.com/octocat/Hello-World/releases.atom'), null, 'already a feed → null');

// ── friendly name ──
assert.equal(githubName('https://github.com/octocat/Hello-World'), 'octocat/Hello-World releases');
assert.equal(githubName('https://github.com/octocat/Hello-World/commits'), 'octocat/Hello-World commits');
assert.equal(githubName('https://github.com/octocat'), 'octocat (github)');

// ── match: github.com only (not gist / pages / raw) ──
assert.equal(githubAdapter.match('https://github.com/octocat/Hello-World'), true);
assert.equal(githubAdapter.match('github.com/octocat/repo'), true, 'scheme-less');
assert.equal(githubAdapter.match('https://gist.github.com/octocat/abc'), false, 'gist excluded');
assert.equal(githubAdapter.match('https://octocat.github.io/page'), false, 'pages excluded');
assert.equal(githubAdapter.match('https://example.com/feed'), false);

// ── parse releases.atom → release items, sanitized, with structured ref ──
const RELEASES = `<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes from Hello-World</title>
  <link rel="alternate" href="https://github.com/octocat/Hello-World/releases"/>
  <entry>
    <id>tag:github.com,2008:Repository/123/v1.2.0</id>
    <title>v1.2.0</title>
    <updated>2026-05-01T12:00:00Z</updated>
    <link rel="alternate" href="https://github.com/octocat/Hello-World/releases/tag/v1.2.0"/>
    <author><name>octocat</name></author>
    <content type="html">&lt;p&gt;Notes&lt;/p&gt;&lt;script&gt;evil()&lt;/script&gt;</content>
  </entry>
</feed>`;
const rel = parseGithub(RELEASES, { feed: { id: 'gh', url: 'https://github.com/octocat/Hello-World/releases.atom', images_allowed: false } });
assert.equal(rel.items.length, 1, 'one release');
const r = rel.items[0];
assert.equal(r.type, 'release', 'mapped to release type');
assert.equal(r.title, 'v1.2.0');
assert.equal(r.author, 'octocat');
assert.equal(r.structured.repo, 'octocat/Hello-World', 'repo captured');
assert.equal(r.structured.ref, 'v1.2.0', 'tag ref from id tail');
assert.ok(r.published_at > 0, 'date parsed');
assert.ok(/Notes/.test(r.content) && !/script|evil/i.test(r.content), 'content sanitized (script stripped)');
assert.equal(r.id, 'gh:tag:github.com,2008:Repository/123/v1.2.0', 'stable id from entry id');

// ── parse commits.atom → commit items with short sha ──
const COMMITS = `<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Recent Commits to Hello-World:main</title>
  <entry>
    <id>tag:github.com,2008:Commit/octocat/Hello-World/abc1234567890def</id>
    <title>Fix the thing</title>
    <updated>2026-05-02T09:00:00Z</updated>
    <link rel="alternate" href="https://github.com/octocat/Hello-World/commit/abc1234567890def"/>
    <author><name>dev</name></author>
    <content type="html">diffstat</content>
  </entry>
</feed>`;
const com = parseGithub(COMMITS, { feed: { id: 'gh', url: 'https://github.com/octocat/Hello-World/commits.atom' } });
assert.equal(com.items[0].type, 'commit', 'mapped to commit type');
assert.equal(com.items[0].structured.ref, 'abc1234', 'short sha (7)');
assert.equal(com.items[0].title, 'Fix the thing');

// ── a non-feed (HTML repo page) → 0 items, and detectFeedUrl resolves it ──
assert.deepEqual(parseGithub('<html><body>repo page</body></html>', { feed: { id: 'gh' } }).items, [], 'HTML page → no items');
assert.equal(githubAdapter.detectFeedUrl('https://github.com/octocat/Hello-World'), 'https://github.com/octocat/Hello-World/releases.atom', 'detectFeedUrl resolves repo URL');

console.log('github smoke ok:', JSON.stringify({ release: r.type, commit: com.items[0].type }));
