import { describe, it, expect } from 'vitest';
import {
  extractImagePaths,
  extractOpenablePaths,
  findOpenablePaths,
  isHtmlExtension,
  isOpenableExtension,
  isSecretPath,
  isVideoExtension,
  OPENABLE_BARE_FILENAME_RE,
  OPENABLE_BARE_FILENAME_INLINE_RE,
} from './paths.js';

describe('extractImagePaths', () => {
  it('extracts absolute paths with spaces in the basename', () => {
    const path = '/home/user/Pictures/Screenshots/Screenshot From 2026-04-12 20-31-12.png';
    expect(extractImagePaths(`Saved to ${path}`)).toEqual([path]);
  });

  it('extracts full absolute path when a directory segment contains a space', () => {
    const path = '/home/user/My Project/out.png';
    expect(extractImagePaths(`Wrote ${path} successfully`)).toEqual([path]);
    expect(extractImagePaths(path)).toEqual([path]);
  });

  it('extracts nested paths after ~/', () => {
    expect(extractImagePaths('see ~/Pictures/Screenshots/foo.png here')).toEqual([
      '~/Pictures/Screenshots/foo.png',
    ]);
  });

  it('extracts ./ and bare relative paths', () => {
    expect(extractImagePaths('logo at ./assets/logo.png')).toEqual(['./assets/logo.png']);
    expect(extractImagePaths('diagram in docs/diagram.png')).toEqual(['docs/diagram.png']);
  });

  it('still extracts clean absolute paths', () => {
    expect(extractImagePaths('/tmp/foo.png')).toEqual(['/tmp/foo.png']);
  });

  it('does not extract paths inside https URLs', () => {
    expect(extractImagePaths('https://example.com/x.png')).toEqual([]);
    expect(extractImagePaths('https://cdn.example.com/img/photo.png')).toEqual([]);
  });

  it('rewrites web-root absolute paths to project-relative targets', () => {
    // Bare after rewrite — the preview strip skips it so it does not 404.
    expect(extractImagePaths('src=/tierwyn-icon.svg')).toEqual([]);
    expect(extractImagePaths('icon /icons/icon-192.png')).toEqual(['icons/icon-192.png']);
  });

  it('extracts home Media library paths', () => {
    const path = '/home/user/Media/Images/tierwyn-logo.png';
    expect(extractImagePaths(`logo at ${path}`)).toEqual([path]);
  });

  it('extracts parenthesized absolute paths', () => {
    expect(extractImagePaths('(see /tmp/tierwyn-compare.png)')).toEqual(['/tmp/tierwyn-compare.png']);
  });

  it('does not thumbnail bare filenames mentioned in prose', () => {
    const text = 'The build listed four media files as missing (agent-activity.png, hero.mp4, model-picker.png, install.mp4)';
    expect(extractImagePaths(text)).toEqual([]);
  });

  it('strips a leading @ from adapter path mentions so /files can resolve them', () => {
    expect(extractOpenablePaths('see @/tmp/tierwyn-attachments/shot.png')).toEqual([
      '/tmp/tierwyn-attachments/shot.png',
    ]);
    expect(extractImagePaths('see @/tmp/tierwyn-attachments/shot.png')).toEqual([
      '/tmp/tierwyn-attachments/shot.png',
    ]);
  });
});

describe('extractOpenablePaths', () => {
  it('does not produce partial tail matches after spaces in absolute paths', () => {
    const text = '/home/user/My Project/out.png';
    const paths = extractOpenablePaths(text);
    expect(paths).toEqual([text]);
    expect(paths).not.toContain('Project/out.png');
  });

  it('recognizes json, yaml, and yml as openable extensions', () => {
    expect(isOpenableExtension('json')).toBe(true);
    expect(isOpenableExtension('jsonc')).toBe(true);
    expect(isOpenableExtension('yaml')).toBe(true);
    expect(isOpenableExtension('yml')).toBe(true);
  });

  it('matches single bare openable filenames with OPENABLE_BARE_FILENAME_RE', () => {
    expect(OPENABLE_BARE_FILENAME_RE.test('CLAUDE.md')).toBe(true);
    expect(OPENABLE_BARE_FILENAME_RE.test('README.md')).toBe(true);
    expect(OPENABLE_BARE_FILENAME_RE.test('sftp.md')).toBe(true);
    expect(OPENABLE_BARE_FILENAME_RE.test('package.json')).toBe(true);
    expect(OPENABLE_BARE_FILENAME_RE.test('config.yaml')).toBe(true);
    expect(OPENABLE_BARE_FILENAME_RE.test('unknown.ext123')).toBe(false);
    expect(OPENABLE_BARE_FILENAME_RE.test('word')).toBe(false);
  });

  it('finds bare .md/.txt filenames in prose via OPENABLE_BARE_FILENAME_INLINE_RE', () => {
    const text = 'Check CLAUDE.md and notes.txt for context.';
    OPENABLE_BARE_FILENAME_INLINE_RE.lastIndex = 0;
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = OPENABLE_BARE_FILENAME_INLINE_RE.exec(text)) !== null) {
      matches.push(m[1]);
    }
    expect(matches).toEqual(['CLAUDE.md', 'notes.txt']);
    expect(findOpenablePaths(text).map((x) => x.path)).toEqual(['CLAUDE.md', 'notes.txt']);
    expect(extractOpenablePaths(text)).toEqual(['CLAUDE.md', 'notes.txt']);
  });

  it('linkifies bare .png/.tsx words as inline filenames', () => {
    const text = 'Open icon.png or App.tsx in the editor.';
    expect(findOpenablePaths(text).map((m) => m.path)).toEqual(['icon.png', 'App.tsx']);
    expect(extractOpenablePaths(text)).toEqual(['icon.png', 'App.tsx']);
  });

  it('does not linkify collision-prone bare extensions or Node.js', () => {
    const text = 'Rewrite main.go and kernel.c, check x.h plus run.m — built with Node.js.';
    expect(extractOpenablePaths(text)).toEqual([]);
  });

  it('still matches screenshot basenames with spaces', () => {
    const path = '/home/u/Screenshot 2026-09-11.png';
    expect(extractOpenablePaths(`Saved ${path}`)).toEqual([path]);
    expect(findOpenablePaths(`Saved ${path}`).map((m) => m.path)).toEqual([path]);
  });

  it('splits the terminal bridge (a.md see notes.txt) into two matches', () => {
    const text = 'Saved /home/u/a.md see notes.txt';
    expect(extractOpenablePaths(text)).toEqual(['/home/u/a.md', 'notes.txt']);
    expect(findOpenablePaths(text).map((m) => m.path)).toEqual(['/home/u/a.md', 'notes.txt']);
  });

  it('splits the slash bridge (./a.md and ../b.txt) into two matches', () => {
    const text = './docs/plan.md and ../docs/b.txt';
    expect(extractOpenablePaths(text)).toEqual(['./docs/plan.md', '../docs/b.txt']);
    expect(findOpenablePaths(text).map((m) => m.path)).toEqual(['./docs/plan.md', '../docs/b.txt']);
  });

  it('rewrites web-root absolute paths to project-relative fetch targets', () => {
    expect(findOpenablePaths('path is /docs/plan.md').map((m) => m.path)).toEqual(['docs/plan.md']);
    expect(findOpenablePaths('icon /icons/icon-192.png').map((m) => m.path)).toEqual(['icons/icon-192.png']);
    expect(extractOpenablePaths('path is /docs/plan.md')).toEqual(['docs/plan.md']);
  });

  it('drops system-root absolute paths entirely', () => {
    expect(extractOpenablePaths('config at /etc/nginx/nginx.conf')).toEqual([]);
    expect(findOpenablePaths('see /usr/share/doc/readme.md')).toEqual([]);
  });

  it('matches uppercase extensions case-insensitively', () => {
    expect(extractOpenablePaths('saved /home/user/PHOTO.JPG')).toEqual(['/home/user/PHOTO.JPG']);
    expect(extractOpenablePaths('see ./diagram.PNG')).toEqual(['./diagram.PNG']);
    expect(findOpenablePaths('read /home/user/README.MD').map((m) => m.path)).toEqual(['/home/user/README.MD']);
    expect(OPENABLE_BARE_FILENAME_RE.test('photo.JPG')).toBe(true);
    expect(OPENABLE_BARE_FILENAME_RE.test('IMAGE.PNG')).toBe(true);
  });

  it('recognizes new openable extensions (csv, xml, mdx, ico, avif)', () => {
    expect(isOpenableExtension('csv')).toBe(true);
    expect(isOpenableExtension('tsv')).toBe(true);
    expect(isOpenableExtension('xml')).toBe(true);
    expect(isOpenableExtension('mdx')).toBe(true);
    expect(isOpenableExtension('ico')).toBe(true);
    expect(isOpenableExtension('avif')).toBe(true);
    expect(extractOpenablePaths('exported data at /tmp/export.csv')).toEqual(['/tmp/export.csv']);
    expect(extractOpenablePaths('icon at /tmp/favicon.ico')).toEqual(['/tmp/favicon.ico']);
  });

  it('matches file:// URIs with percent-encoded spaces (%20)', () => {
    const uri = 'file:///home/user/My%20Pictures/vacation.png';
    expect(findOpenablePaths(`open ${uri} now`).map((m) => m.path)).toEqual([uri]);
    expect(extractOpenablePaths(`open ${uri} now`)).toEqual(['/home/user/My Pictures/vacation.png']);
  });

  it('does not ReDoS on long file:// URIs with non-openable extensions (.gz)', () => {
    // Catastrophic backtracking in OPENABLE_FILE_URI_RE used to freeze the SPA
    // when tool results contained Grok Bot sandbox attachment URLs ending in .gz.
    const hash = 'd9323c56c0bc59405d6fb1e36b04190eb786b08e6276c9a16ea793d16b0c492f';
    const poison = `file:///home/box/sand-data/agents/399c87f2-d6d3-4977-9db2-b987d893e620/attachments/${hash}.gz`;
    const t0 = performance.now();
    expect(findOpenablePaths(`probe ${poison} and file:///home/box/nope/x.bin`).map((m) => m.path)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('still matches long file:// URIs that end in an openable extension', () => {
    const hash = 'd9323c56c0bc59405d6fb1e36b04190eb786b08e6276c9a16ea793d16b0c492f';
    const uri = `file:///home/box/agent-data/agents/ab6aa1a0-57b6-4fa7-b9d9-4645347ed24c/attachments/${hash}.md`;
    expect(findOpenablePaths(`see ${uri}`).map((m) => m.path)).toEqual([uri]);
  });

  it('matches bare screenshot filenames with spaces via OPENABLE_BARE_FILENAME_RE', () => {
    expect(OPENABLE_BARE_FILENAME_RE.test('Screenshot 2026-09-11.png')).toBe(true);
    expect(OPENABLE_BARE_FILENAME_RE.test('Screenshot From 2026-08-01 11-36-35.png')).toBe(true);
  });

  it('recognizes audio extensions and extracts audio paths', () => {
    expect(isOpenableExtension('mp3')).toBe(true);
    expect(isOpenableExtension('wav')).toBe(true);
    expect(isOpenableExtension('ogg')).toBe(true);
    expect(isOpenableExtension('m4a')).toBe(true);
    expect(isOpenableExtension('flac')).toBe(true);
    expect(isOpenableExtension('opus')).toBe(true);
    expect(extractOpenablePaths('listen to track.mp3 and podcast.wav here')).toEqual(['track.mp3', 'podcast.wav']);
    expect(extractOpenablePaths('audio at /home/user/music/sample.mp3')).toEqual(['/home/user/music/sample.mp3']);
  });

  it('matches screenshot filenames with spaces in inline prose via findOpenablePaths', () => {
    const paths1 = findOpenablePaths('saved to Screenshot 2026-09-11.png for review');
    expect(paths1.map((p) => p.path)).toEqual(['Screenshot 2026-09-11.png']);

    const paths2 = findOpenablePaths('check Screenshot From 2026-08-01 11-36-35.png right now');
    expect(paths2.map((p) => p.path)).toEqual(['Screenshot From 2026-08-01 11-36-35.png']);

    const paths3 = findOpenablePaths('/home/user/Screenshot 2026-09-11.png is still failing');
    expect(paths3.map((p) => p.path)).toEqual(['/home/user/Screenshot 2026-09-11.png']);
  });
});

describe('isVideoExtension', () => {
  it('accepts common video container extensions case-insensitively', () => {
    for (const ext of ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi']) {
      expect(isVideoExtension(ext)).toBe(true);
      expect(isVideoExtension(ext.toUpperCase())).toBe(true);
    }
  });

  it('rejects non-video extensions', () => {
    expect(isVideoExtension('png')).toBe(false);
    expect(isVideoExtension('mp3')).toBe(false);
    expect(isVideoExtension('md')).toBe(false);
  });

  it('treats video extensions as openable so they serve and linkify', () => {
    expect(isOpenableExtension('mp4')).toBe(true);
    expect(isOpenableExtension('mkv')).toBe(true);
    // Video paths are extracted from prose like other openable files
    expect(extractOpenablePaths('rendered to /tmp/out/render.mp4')).toEqual(['/tmp/out/render.mp4']);
  });
});

describe('isSecretPath', () => {
  it('blocks agent credential files', () => {
    expect(isSecretPath('/home/u/.claude/.credentials.json')).toBe(true);
    expect(isSecretPath('/home/u/.codex/auth.json')).toBe(true);
    expect(isSecretPath('/home/u/.gemini/oauth_creds.json')).toBe(true);
    expect(isSecretPath('/home/u/.gemini/google_accounts.json')).toBe(true);
    expect(isSecretPath('/home/u/.config/gh/hosts.yml')).toBe(true);
    expect(isSecretPath('/proj/token.json')).toBe(true);
    expect(isSecretPath('/proj/notes.md')).toBe(false);
  });
});

describe('isHtmlExtension', () => {
  it('accepts html and htm case-insensitively', () => {
    expect(isHtmlExtension('HTML')).toBe(true);
    expect(isHtmlExtension('html')).toBe(true);
    expect(isHtmlExtension('htm')).toBe(true);
    expect(isHtmlExtension('HTM')).toBe(true);
  });

  it('rejects other extensions', () => {
    expect(isHtmlExtension('md')).toBe(false);
    expect(isHtmlExtension('txt')).toBe(false);
  });
});


