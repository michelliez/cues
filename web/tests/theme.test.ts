import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isEnabled } from "../lib/flags.ts";
import { THEME_KEY, themeScript } from "../lib/theme.ts";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

test("theme toggle defaults on; without it no script runs and no toggle shows", () => {
  assert.equal(isEnabled("web.theme_toggle", {}), true);
  assert.equal(
    isEnabled("web.theme_toggle", { CUES_FLAG_WEB_THEME_TOGGLE: "0" }),
    false,
  );
  assert.equal(
    isEnabled("web.theme_toggle", { CUES_FLAG_WEB_THEME_TOGGLE: "1" }),
    true,
  );
  assert.match(
    read("../app/layout.tsx"),
    /isEnabled\("web\.theme_toggle"\) \? \(\s*<head>/,
  );
  assert.match(read("../components/landing.tsx"), /\{themeToggle \? \(/);
  assert.match(
    read("../components/workspace-sidebar.tsx"),
    /\{themeToggle \? \(/,
  );
  assert.match(
    read("../components/teacher-login.tsx"),
    /\{themeToggleEnabled \? \(/,
  );
});

test("the saved theme applies only for known values; the landing page defaults to light", () => {
  const root = { attrs: {} as Record<string, string> };
  const run = (stored: string | null, path = "/dashboard") => {
    root.attrs = {};
    const localStorage = {
      getItem: (key: string) => (key === THEME_KEY ? stored : null),
    };
    const document = {
      documentElement: {
        setAttribute: (name: string, value: string) =>
          (root.attrs[name] = value),
      },
    };
    new Function("localStorage", "document", "location", themeScript)(
      localStorage,
      document,
      { pathname: path },
    );
    return root.attrs["data-theme"];
  };
  assert.equal(run("light"), "light");
  assert.equal(run("dark"), "dark");
  assert.equal(run("purple"), undefined);
  assert.equal(run(null), undefined);
  // No saved choice: only the landing page starts light, and says it chose that itself.
  assert.equal(run(null, "/"), "light");
  assert.equal(root.attrs["data-theme-auto"], "1");
  assert.equal(run(null, "/login"), undefined);
  // A saved choice always wins, on the landing page too, and is not marked automatic.
  assert.equal(run("dark", "/"), "dark");
  assert.equal(root.attrs["data-theme-auto"], undefined);
});

test("the landing page's default does not leak to other pages, and a click makes it the visitor's", () => {
  const defaults = read("../components/landing-theme-default.tsx");
  assert.match(defaults, /root\.removeAttribute\("data-theme"\)/);
  assert.match(read("../components/landing.tsx"), /themeToggle \? <LandingThemeDefault \/>/);
  assert.match(read("../components/landing.tsx"), /pageDefault="light" className="ln-theme-toggle"/);
  assert.match(read("../components/theme-toggle.tsx"), /root\.removeAttribute\(AUTO_THEME_ATTRIBUTE\)/);
});

test("/live and /settings/notifications fold into the pages that do the work", () => {
  // The Live screen's people, counts and requests live on Classroom now.
  assert.throws(() => isEnabled("web.live_view", {}));
  assert.throws(() => isEnabled("web.room_view", {}));
  assert.match(read("../app/live/page.tsx"), /redirect\("\/dashboard"\)/);
  // Photon alerts are set up on Profile, next to the alert phone.
  assert.match(
    read("../app/settings/notifications/page.tsx"),
    /redirect\("\/settings\/profile#notifications"\)/,
  );
  assert.match(read("../components/demo-notifications.tsx"), /id="notifications"/);
});

test("a person's request is in plain words; model details wait behind Why", () => {
  const panel = read("../components/person-panel.tsx");
  assert.match(panel, /<details className="person-why">/);
  assert.match(panel, /teacherRationale\(review\.rationale\)/);
  // Expression never reaches the teacher's panel.
  assert.doesNotMatch(
    panel.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""),
    /expression/i,
  );
  const dashboard = read("../components/dashboard.tsx");
  // Signed out, the classroom asks to sign in instead of showing errors.
  assert.match(dashboard, /\{signedOut \? \(\s*<SignInCard \/>/);
  assert.match(dashboard, /href="\/login"/);
});

test("review decisions read as support needed or not, on the same statuses", async () => {
  const { resolutionLabels, reviewPrompt } =
    await import("../lib/teacher-reviews.ts");
  // The labels change; the stored values do not, and no new status exists.
  assert.deepEqual(resolutionLabels, {
    confirmed: "Support needed",
    dismissed: "No support needed",
  });
  assert.equal(reviewPrompt.title, "Student may need support");
  assert.doesNotMatch(
    `${reviewPrompt.title} ${reviewPrompt.detail}`,
    /diagnos|emotion|distress|attention span|struggl/i,
  );
  const actions = read("../components/teacher-review-actions.tsx");
  assert.match(
    actions,
    /resolve\("confirmed"\)[\s\S]*resolutionLabels\.confirmed/,
  );
  assert.match(
    actions,
    /resolve\("dismissed"\)[\s\S]*resolutionLabels\.dismissed/,
  );
  assert.doesNotMatch(actions, /"Needs attention"|"Dismiss"/);
});

test("the rail keeps Classroom, To review (when on) and Profile", () => {
  const rail = read("../components/workspace-sidebar.tsx");
  // The current entry follows the URL, not a fixed page.
  assert.match(rail, /usePathname\(\)/);
  const links = new Set(
    [...rail.matchAll(/<Link\s+href="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((href) => href !== "/"),
  );
  // The profile holds email, sign-out and alerts; nothing in the rail sends a
  // signed-in teacher to the sign-in page.
  assert.deepEqual([...links].sort(), ["/dashboard", "/review", "/settings/profile"]);
  assert.match(rail, /\{reviewPage \? \(\s*<Link href="\/review"/);
  assert.doesNotMatch(rail, /href="\/login"|\/live|\/settings\/notifications/);
});

test("the To review page is on by default and redirects when off", () => {
  assert.equal(isEnabled("web.review_page", {}), true);
  assert.equal(
    isEnabled("web.review_page", { CUES_FLAG_WEB_REVIEW_PAGE: "0" }),
    false,
  );
  assert.equal(
    isEnabled("web.review_page", { CUES_FLAG_WEB_REVIEW_PAGE: "1" }),
    true,
  );
  const page = read("../app/review/page.tsx");
  assert.match(
    page,
    /if \(!isEnabled\("web\.review_page"\) \|\| !isEnabled\("web\.dashboard"\)\)\s*redirect\("\/dashboard"\)/,
  );
  assert.match(page, /view="review"/);
  // With the flag off, the classroom shows no To review link or pill.
  const dashboard = read("../components/dashboard.tsx");
  assert.match(dashboard, /\) : reviewPageEnabled \? \(\s*<Link/);
  assert.match(dashboard, /reviewPage=\{reviewPageEnabled\}/);
  assert.match(
    read("../app/dashboard/page.tsx"),
    /reviewPageEnabled=\{isEnabled\("web\.review_page"\)\}/,
  );
});


test("people are labelled as the backend names them, never made-up names", () => {
  assert.throws(() => isEnabled("web.simulated_names", {}));
  for (const file of ["dashboard.tsx"]) {
    const source = read(`../components/${file}`);
    assert.doesNotMatch(source, /simulated-names|displayName\(/);
    // Everyone with a seat, and the seats with an observation of the current session.
    assert.match(source, /const allSeats = feed\.snapshot \? seatViews\(feed\.snapshot\) : \[\];/);
    assert.match(
      source,
      /const seats = feed\.snapshot\s*\? seatViews\(currentObservations\(feed\.snapshot, observationContext\)\)/,
    );
  }
});

test("the workspace shows no simulated class or data labels", () => {
  for (const file of ["dashboard.tsx", "person-panel.tsx"])
    assert.doesNotMatch(
      read(`../components/${file}`),
      /simulated class|Simulated data|Simulated seat|Simulated class/,
    );
});

test("no page shows a Workspace / … breadcrumb", async () => {
  const { readdirSync } = await import("node:fs");
  const files = ["../components/", "../app/"].flatMap((dir) =>
    readdirSync(new URL(dir, import.meta.url), { recursive: true })
      .map(String)
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => `${dir}${name}`),
  );
  assert.ok(files.length > 20, "found the components and pages");
  for (const file of files) {
    assert.doesNotMatch(
      read(file),
      /page-breadcrumb|Workspace\s*(<span>)?\s*\/\s*(<\/span>)?/,
      file,
    );
  }
});

test("alert copy names only the seat, matching what Photon sends", () => {
  for (const file of [
    "demo-notifications.tsx",
    "teacher-login.tsx",
    "teacher-profile-form.tsx",
  ]) {
    const source = read(`../components/${file}`);
    assert.match(source, /only the seat|seat, never images/, file);
    assert.doesNotMatch(source, /seat\s+and\s+(the\s+)?task/, file);
  }
});
