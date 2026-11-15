// Seam: SECURITY.md read as text, the way a user finds it (and the maintainer guide's account checklist, read the same way). The section
// on the GitHub token that `wf doctor`'s warning points at is there under the heading the doctor names, and says what a leaked token
// exposes, how to narrow it and which token to use. The scopes come from the doctor's own list (`BROAD_SCOPES`), so the text cannot drift
// from what the doctor warns about. The Privacy Mode section links Cursor's data-use page and says what the kit does about a setting it
// cannot read. The section on who receives the user's data names every party with what it gets, from which step and what governs its
// retention; the key section says how the Cursor key is born, expires, is rotated and revoked. Whether the links resolve is
// docs-check.test.ts; the doctor itself is packages/runtime/test/doctor.process.test.ts. The research chapter's record of the
// implement-issue run under the sandbox (issue #99) and what SECURITY.md says of it are read the same way, at the end of the file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseMarkdown, sectionOf } from "../scripts/lib/markdown.js";
import { BROAD_SCOPES, SECURITY_TOKEN_SECTION } from "../packages/runtime/src/github-token-scopes.js";

const SECURITY = readFileSync(join(resolve(import.meta.dirname, ".."), "SECURITY.md"), "utf8");

test("SECURITY.md has one section on the GitHub token, under the heading the doctor's warning names", () => {
  assert.equal(SECURITY_TOKEN_SECTION, "O token do GitHub");
  const sections = parseMarkdown(SECURITY).headings.filter((h) => h.level === 2 && h.text === SECURITY_TOKEN_SECTION);
  assert.equal(sections.length, 1, `SECURITY.md needs exactly one "## ${SECURITY_TOKEN_SECTION}" section`);
});

test("the GitHub-token section names every scope the doctor warns about, how to remove them, and the fine-grained token to use instead", () => {
  const section = sectionOf(SECURITY, SECURITY_TOKEN_SECTION);
  assert.ok(section, `SECURITY.md has no "## ${SECURITY_TOKEN_SECTION}" section`);
  for (const scope of BROAD_SCOPES) assert.ok(section.includes(`\`${scope}\``), `the section does not name the scope ${scope}, which \`wf doctor\` warns about`);
  for (const needle of ["wf doctor", "--remove-scopes", "GH_TOKEN", "fine-grained", "Contents", "Pull requests", "Issues", "Metadata", "expiração"]) {
    assert.ok(section.includes(needle), `the section does not mention ${needle}`);
  }
});

// Privacy Mode is the user's setting on their Cursor account: the SDK cannot read it, so SECURITY.md is where a reader learns what it
// changes and what the kit does about it (the install guide asks, the doctor reminds, the book's chapter 5.1 holds the model advice).
test("SECURITY.md has a Privacy Mode section that links Cursor's data-use page, says where to confirm the mode, and points the model advice to the allowedModels cap", () => {
  const section = sectionOf(SECURITY, "Privacy Mode");
  assert.ok(section, 'SECURITY.md has no "## Privacy Mode" section');
  assert.ok(parseMarkdown(SECURITY).links.some((l) => l.target === "https://cursor.com/data-use"), "SECURITY.md does not link https://cursor.com/data-use");
  for (const needle of ["Cursor Settings → General", "wf doctor", "INSTALL-AGENT.md", "allowedModels", "ZDR"]) {
    assert.ok(section.includes(needle), `the Privacy Mode section does not mention ${needle}`);
  }
});

// The runtime hardening of issue #70: what SECURITY.md says of each, in the words a reader would search for.
test("SECURITY.md says what the runtime hardening does: the job cap, the scrubbed environment, the snapshot guard, the repository's code, and wf init's symlinks", () => {
  const says = (what: string, ...needles: string[]) => {
    for (const needle of needles) assert.ok(SECURITY.includes(needle), `SECURITY.md does not say ${what}: no "${needle}"`);
  };
  says("how many jobs run at once", "caps.maxRunningJobs", "mesmo workflow", "mesmos args");
  says("that the tests and the setup command do not see the environment's secrets", "`setupCommand`", "`CURSOR_API_KEY`", "`GH_TOKEN`", "KEY", "TOKEN", "SECRET", "PASSWORD");
  says("what is checked before a cloud snapshot is pushed", "`cloud.allowPublicRemote`", "gh repo view", "PUBLIC", "não despublica", "fecha o caminho");
  says("that wf doctor and a run list the code of the repository's settings", ".cursor/hooks.json", ".claude/settings.json", ".cursor/mcp.json", "`wf doctor` avisa", "`warning`");
  says("that wf init stays inside the repository", "link simbólico", "`wf init`", "CWE-59");
  // The issue #71 pins: where the Cursor key, the forge token and the installer script may go.
  says("that the Cursor key goes only to a Cursor endpoint", "`CURSOR_BACKEND_URL`", "`CURSOR_WEBSITE_URL`", "`cursor.sh`", "`cursor.com`", "`endpoints`");
  says("which hosts the repo argument may name", "`workflows.implement-issue.settings.repoHosts`", "`HOST/OWNER/REPO`", "`forges`", "`GH_ENTERPRISE_TOKEN`");
  says("how the installer is downloaded and which git transports are allowed", "--proto '=https'", "mktemp", "`GIT_ALLOW_PROTOCOL=file:https:ssh`", "`ext::`");
});

/** `text` on one line: the prose is hard-wrapped, so a phrase a test looks for may break across lines. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

/** The rows of the first Markdown table in `section`, as their cells, header and separator left out. */
function tableRows(section: string): string[][] {
  return section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.slice(1, line.lastIndexOf("|")).split("|").map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^-+$/.test(cell)))
    .slice(1);
}

// The user's data goes to more places than the cloud snapshot: SECURITY.md names each recipient in one table, so a reader judging the
// kit's risk finds them together, with the page that governs each one's retention.
test("SECURITY.md has one section on who receives the user's data: a row per party with what it gets, from which step and what governs it, and the pages that say so", () => {
  const sections = parseMarkdown(SECURITY).headings.filter((h) => h.level === 2 && h.text === "Quem recebe os seus dados");
  assert.equal(sections.length, 1, 'SECURITY.md needs exactly one "## Quem recebe os seus dados" section');
  const section = sectionOf(SECURITY, "Quem recebe os seus dados");
  assert.ok(section, 'SECURITY.md has no "## Quem recebe os seus dados" section');

  const rows = tableRows(section);
  const parties = [/^A Cursor e os provedores de modelo/, /^As VMs na nuvem da Cursor/, /^O GitHub/, /^A telemetria do SDK da Cursor/];
  assert.deepEqual(
    rows.map((cells) => parties.findIndex((party) => party.test(cells[0] ?? ""))),
    [0, 1, 2, 3],
    `the table needs one row per party, in this order: ${parties.join(" ")}; it has ${rows.map((cells) => cells[0]).join(" | ")}`,
  );
  for (const cells of rows) assert.ok(cells.length === 4 && cells.every((cell) => cell !== ""), `"${cells[0]}": a row says who, what it gets, from which step and what governs retention or training`);

  for (const url of [
    "https://cursor.com/data-use",
    "https://cursor.com/docs/cloud-agent/security-network",
    "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement",
  ]) {
    assert.ok(section.includes(`](${url})`), `the section does not link ${url}`);
  }
  for (const needle of ["Privacy Mode", "`caps.allowedModels`", "`location: \"cloud\"`", "30 dias", "`wf/cloud-snapshot/`"]) {
    assert.ok(section.includes(needle), `the section does not mention ${needle}`);
  }
});

// The key's lifecycle is the maintainer's to run and the user's to follow: how `wf login` mints it and when it expires, which copies exist,
// how to rotate and revoke it, and the cap that also binds a key used outside the kit. The doctor's `login` check and the CLI's output tell
// the same story from the code side (cli-account.process.test.ts proves the key itself is never printed).
test("the section on the Cursor key says how the key is created, when it expires, where its copies are, how to rotate and revoke it, and that a spend limit in the Cursor dashboard is the cap the kit's own caps are not", () => {
  const section = sectionOf(SECURITY, "A chave do Cursor");
  assert.ok(section, 'SECURITY.md has no "## A chave do Cursor" section');
  const says = (what: string, ...needles: string[]) => {
    for (const needle of needles) assert.ok(flat(section).includes(needle), `the key section does not say ${what}: no "${needle}"`);
  };
  says("how `wf login` creates the key and when it expires", "`wf login`", "`Cursor.auth.login()`", "expira em 90 dias", "`expiresAt`");
  says("where each copy of the key lives", "`~/.cursor/sdk/auth.json`", "`CURSOR_API_KEY`");
  says("how to rotate the key", "Como rotacionar", "`wf login` de novo", "revogue a chave velha");
  says("how to revoke the key", "Como revogar", "lista de chaves de API", "não revoga");
  says("that the kit's caps do not bind a leaked key and a spend limit does", "limite de gasto", "`maxCents`", "fora do kit");
});

// On WSL, `0600` on the key file is no protection against a Windows process, and interop lets a step start one: the paragraph says so and
// what to do about it, in the section on what the kit does on the machine. The doctor's `host` warning points at it as "the paragraph on
// WSL" in SECURITY.md: the runtime's source holds no Portuguese, so it cannot name the heading.
test("the section on what the kit does on the machine has the WSL paragraph: how a Windows process reaches the key, a separate distribution, and interop off in wsl.conf", () => {
  const heading = "O que o kit faz na sua máquina";
  assert.equal(parseMarkdown(SECURITY).headings.filter((h) => h.level === 2 && h.text === heading).length, 1);
  const section = sectionOf(SECURITY, heading);
  assert.ok(section, `SECURITY.md has no "## ${heading}" section`);
  for (const needle of ["WSL", "`\\\\wsl$`", "`~/.cursor/sdk/auth.json`", "0600", "distribuição WSL separada", "`[interop]`", "`enabled=false`", "`/etc/wsl.conf`", "`wsl --terminate", "`wf doctor`", "verificação `host`"]) {
    assert.ok(flat(section).includes(needle), `the WSL paragraph does not mention ${needle}`);
  }
});

// Every install trusts the account that owns the releases, so the maintainer guide carries the checklist that keeps it: what to set once (the
// how-to issue holds the steps) and what to audit every quarter.
test("the maintainer guide has a Conta do mantenedor checklist: 2FA with no SMS, SSH signing with vigilant mode, a quarterly audit of keys and apps, a quarterly export of the security log, and the how-to for the one-time settings", () => {
  const guide = readFileSync(join(resolve(import.meta.dirname, ".."), "docs", "contributing", "04-scripts-do-mantenedor.md"), "utf8");
  assert.equal(parseMarkdown(guide).headings.filter((h) => h.level === 2 && h.text === "Conta do mantenedor").length, 1, 'the guide needs exactly one "## Conta do mantenedor" section');
  const section = sectionOf(guide, "Conta do mantenedor");
  assert.ok(section, 'the guide has no "## Conta do mantenedor" section');
  const items = section.split(/^- \[ \] /m).slice(1); // each item runs to the next one, over its continuation lines
  assert.equal(items.length, 4, `the checklist has four items (2FA, signing, the quarterly audit, the security log), not ${items.length}`);
  const [twoFactor, signing, audit, securityLog] = items.map(flat) as [string, string, string, string];
  for (const needle of ["passkey", "TOTP", "nunca por SMS", "códigos de recuperação", "offline"]) assert.ok(twoFactor.includes(needle), `the 2FA item does not mention ${needle}`);
  for (const needle of ["Assinatura SSH", "commits e tags", "vigilant mode"]) assert.ok(signing.includes(needle), `the signing item does not mention ${needle}`);
  for (const needle of ["trimestre", "chaves SSH", "deploy keys", "OAuth", "GitHub Apps", "Cursor"]) assert.ok(audit.includes(needle), `the audit item does not mention ${needle}`);
  for (const needle of ["trimestre", "log de segurança", "90 dias", "Export"]) assert.ok(securityLog.includes(needle), `the security-log item does not mention ${needle}`);
  assert.ok(section.includes("(https://github.com/rodrigorjsf/cursor-workflows-starter/issues/74)"), "the section does not point to the how-to issue #74");
});

// Issue #99: the installer's global config turns the SDK sandbox on for every step, and the #62 probe measured one write step. The whole
// `implement-issue` LOW example ran afterwards with that config; the research chapter holds the dated record (outcome, tokens, which
// backend enforced the sandbox, what it cost against the shared budget), and SECURITY.md says what that run did and did not cover.
const RESEARCH = readFileSync(join(resolve(import.meta.dirname, ".."), "docs", "research", "verificacoes-locais.md"), "utf8");

test("the research chapter records the implement-issue LOW run under caps.requireSandbox: the date, the outcome, the tokens, the sandbox backend, the budget and the clean-up", () => {
  const title = parseMarkdown(RESEARCH).headings.find((h) => h.level === 2 && h.text.startsWith("17. "))?.text;
  assert.ok(title, "the research chapter has no section 17 (the implement-issue run with the sandbox on)");
  const section = sectionOf(RESEARCH, title);
  assert.ok(section, `the research chapter has no "## ${title}" section`);
  const text = flat(section);
  for (const needle of [
    "2026-11-15",
    "caps.requireSandbox: true",
    "templates/global-config.json",
    "complexity:low",
    "`status: \"done\"`",
    "`implement-issue-acfe2c7e`",
    "299.105 tokens",
    "CURSOR_SANDBOX_LANDLOCK_STATUS=fully_enforced",
    "--max-tokens 400000",
    "`git commit`",
    "EAI_AGAIN",
    "[#99](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/99)",
  ]) {
    assert.ok(text.includes(needle), `section 17 does not record ${needle}`);
  }
});

test("SECURITY.md says the implement-issue LOW example ran whole with the sandbox on and points to the record, and keeps what stays unmeasured", () => {
  const text = flat(SECURITY);
  assert.ok(text.includes("o exemplo LOW do `implement-issue` rodou inteiro com o sandbox ligado"), "SECURITY.md does not say that the LOW example ran whole with the sandbox on");
  assert.ok(text.includes("[8.2 §17](docs/research/verificacoes-locais.md)"), "SECURITY.md does not point to section 17 of the research chapter");
  assert.ok(text.includes("**Não medido:** macOS e Windows"), "SECURITY.md no longer lists macOS and Windows as unmeasured");
  assert.ok(!text.includes("e o `implement-issue` inteiro com o sandbox ligado (a sonda"), "SECURITY.md still lists the whole implement-issue as unmeasured under the sandbox");
});
