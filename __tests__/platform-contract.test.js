const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Radar pilot platform contracts', () => {
  test('binds authentication to the first-party Tuku Core client and secure session cookies', () => {
    const server = read('server/index.mjs');
    expect(server).toContain("const CLIENT_ID = 'radar-web'");
    expect(server).toContain("https://core.tukutuku.org");
    expect(server).toContain('HttpOnly; Secure; SameSite=Lax');
    expect(server).toContain("code: 'ORIGIN_DENIED'");
    expect(server).toContain("code: 'AUTH_REQUIRED'");
  });

  test('keeps canonical Core identity and Radar sessions in the data model', () => {
    const schema = read('prisma/schema.prisma');
    expect(schema).toMatch(/coreUserId\s+String\?\s+@unique/);
    expect(schema).toContain('radarSessions');
    expect(schema).toContain('workspaceMemberships');
    expect(schema).toContain('userDocuments');
  });

  test('uses same-origin authenticated API calls and structured errors in the React client', () => {
    const api = read('frontend/src/api.js');
    expect(api).toContain("credentials: 'same-origin'");
    expect(api).toContain('body?.error?.message');
    expect(api).toContain('error.code = body?.error?.code');
    expect(api).toContain('error.status = response.status');
  });

  test('retains mandatory typecheck, test and production-build commands', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts.lint).toContain('tsc --noEmit');
    expect(pkg.scripts.test).toBe('jest');
    expect(pkg.scripts.build).toContain('vite build');
    expect(pkg.scripts.build).toContain('prisma generate');
  });
});
