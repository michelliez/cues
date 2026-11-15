---
name: Cues
description: A calm teacher workspace that shares one visual system with the landing and sign-in pages.
colors:
  night-bg: "#111a3a"
  night-panel: "rgb(255 255 255 / 0.045)"
  night-ink: "#eef1fb"
  night-ink-soft: "#aeb6cc"
  night-ink-faint: "#7c86a3"
  night-accent: "#8fa3ff"
  light-bg: "#f7f7f7"
  light-panel: "#ffffff"
  light-tile: "#f6f6f8"
  light-ink: "#0b0d12"
  light-ink-soft: "#6b6f78"
  light-ink-faint: "#9a9da5"
  blue: "#425cc8"
  done: "#1d6b45"
  done-soft: "#e7f5ed"
  review: "#934d31"
  review-soft: "#fcf0e9"
typography:
  display:
    fontFamily: "EB Garamond, Georgia, serif"
    fontSize: "clamp(40px, 5.5vw, 60px)"
    fontWeight: 500
    letterSpacing: "-0.015em"
  panel-heading:
    fontFamily: "Inter"
    fontSize: "20px"
    fontWeight: 500
  body:
    fontFamily: "Inter"
    fontSize: "14px"
    fontWeight: 400
  caption:
    fontFamily: "Inter"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.08em"
    textTransform: "uppercase"
rounded:
  panel: "28px"
  row: "16px"
  pill: "999px"
spacing:
  panel-padding: "12px"
  gap: "20px"
  gutter: "clamp(20px, 4vw, 48px)"
---
# Design System: Cues

## Overview

Cues has three surfaces that share one look: the landing page (`/`), the sign-in pages (`/login`, `/signup`) and the teacher workspace (`/dashboard`, `/settings/*`). The workspace follows the dashboard that the landing page demo shows, so the product looks the way the marketing promises.

The direction is **very simple and uncluttered**. A screen has few surfaces, small spaced captions, pill buttons and round icon buttons. Model and technical detail waits behind a disclosure. Sources: `web/components/workspace.css`, `dashboard.tsx`, `local-classroom-feed.tsx`, `person-panel.tsx`, `workspace-rows.tsx`, `workspace-sidebar.tsx`, `landing.css`, `auth.css`. The interview that set these decisions is in `notes/teacher-workspace-alignment-spec.md`.

## Themes

Every page has a light/dark toggle (`web.theme_toggle`). The choice is saved per browser in `localStorage` (`cues-theme`). With no saved choice, each page keeps its default: Night for the landing page and the workspace, light for sign-in.

- **Night** uses the landing page navy (`#111a3a`), see-through panels and light ink.
- **Light** uses the sign-in canvas (`#f7f7f7`), white panels and near-black ink.

`workspace.css` defines every color as a `--ws-*` token on `.dashboard-shell`, and redefines the tokens under `:root[data-theme="light"]`. The landing demo window (`.ws-demo`) always uses the light tokens.

## Typography

Inter carries all interface text. EB Garamond (`--font-garamond`) is used only for page titles ("your classroom", "Profile"), as on the landing page. Times use tabular figures. Captions are 11px, uppercase, with 0.08em spacing.

## Layout

**Rail.** A 76px column of 44px round buttons: Classroom, To review (with `web.review_page`, plus a warm count badge while people are waiting) and Profile, with the theme toggle at the bottom. Each button shows its name on hover and keyboard focus. Below 700px the rail becomes a sticky top bar.

**Classroom (`/dashboard`)**, top to bottom:

1. **Header.** No banner: the "your classroom" title and the session controls (activity picker, Start or Change activity, End, and a round button that puts everyone back to working). With `web.reset_people`, that button restarts the current activity after a confirmation, and Change activity also closes the requests still open, so the queue and the people row agree; finished and flagged people start over. Without an activity running (or with the flag off) the button only reloads the session. No status captions sit under the controls ("synced", "waiting for the camera", "finding your classroom", session ownership); only an error from a failed action or load shows there. While the classroom is still being found, the controls are not shown. With `web.review_page`, a "To review" pill sits on the right with the waiting count; it turns warm while people are waiting. The header leaves 28px between the title and the 44px activity controls.
With `web.health_strip`, a **camera health strip** folds behind a round "more" button (three dots) in the same row as the activity controls and refresh. Its badge is green when all is good, amber when something needs a look (including the camera on with no updates arriving), grey while checking, or "No updates" on a hosted page with nothing arriving. Opened, the button stays in place and it shows four pills, each a label and a word (Camera: On, Off, No pictures or Not running here; Classroom: Set, Not set or Another one; Updates: Arriving or Not arriving; Other cameras: None or One refused). A single sentence appears under them only when something needs the teacher (a refused second camera shows even while closed), naming the most useful cause first (another camera, wrong classroom, camera stopped, no updates). It reads this laptop's vision service (`/health`, `/config`) every 3 seconds and the station's writer row. A page that may not reach this laptop (cues.nyc without `web.hosted_local_feed`, or another device) skips the local reads and shows only Updates and Other cameras, with no "service isn't running" sentence.
2. **Camera and Attention, side by side.** The camera card takes about 60% of the width. **Attention** sits beside it at the camera's height and scrolls inside itself. It lists one row per person with a pending review, in queue order (elevated first, then oldest), including people who left the camera's view ("Not in view"). When nobody is waiting it says "All clear". Below 1000px they stack, with Attention first.
3. **Students you slide through** (`student-strip.tsx`), with no heading. Everyone the camera sees, left to right as in the frame, as a row of cards under the camera, starting on the same left edge as the camera. Each card has the initials in a ring tinted by status and the status as a word; someone Cues asked about reads "Check in". The cards follow Attention: while the review feed is live, someone the camera flags but Attention does not list reads "Working", so no card says "Needs review" next to an "All clear". "Attention" names the teacher's queue (the ATTENTION panel), never a student's status: Cues makes no claim about a child's attention. The row scrolls sideways with snap points; round arrow buttons sit on the row's ends, centered on the cards, only on a side with more cards, and that side fades out. Rows and cards show the activity name only when the class is on more than one activity.

**Camera card.** The stage is always 16:9, the camera's own shape, so a live frame fills it with no black bars. The column sets the size; the video never does. Off, the stage shows "Turn on video". Live, it shows the vision service's MJPEG (Motion JPEG) stream from `http://127.0.0.1:8000/stream`, including the service's own overlay (a box and label per person, hand points). The header shows only "Camera", plus a Turn off button while live. The browser remembers in `localStorage` (`cues-video`) that the teacher turned the video on.

**Approving a support (`web.interventions`).** On a request, a menu of the six approved supports and an Approve support button sit above the two decisions. When the agent suggested one, it is preselected and marked "(suggested)"; the teacher can pick another. Approving also confirms the request, like Support needed. The wording describes what an adult does, never how a child feels.

**Opening a person.** A request in Attention opens in place and closes with a second click or Escape. A student card without a request opens that person in the Attention panel, with a back button. Either shows the status in one sentence. For a pending review it also shows "Student may need support", a short plain explanation, the two decisions (Support needed, No support needed), Mark as reviewed, and a closed "Why did Cues ask?" disclosure with the agent's rationale and the evidence types it used.

**To review (`/review`, flag `web.review_page`, default on).** The classroom in its review view, so it reads the same data. A "to review" title (no subtitle), a Back to classroom pill, and one large card per person Cues asked about: a two-digit queue number, initials in a warm ring, the name with Urgent when elevated, the activity in warm small caps ("not in view" and the request count when they apply), "Why did Cues ask?", the two decisions with Mark as reviewed, and the time. One "All clear" line when nobody is waiting. With the flag off, `/review` redirects to `/dashboard` and no links show.

**Signed out.** The Classroom shows one centered card with the Cues companion, "Sign in to see your classroom" and a Sign in button. It shows no error banner and no empty panels.

**Profile (`/settings/profile`).** A large lowercase Garamond title ("profile") and a single 820px column of roomy cards (24px padding, 28px corners), each titled inside the card in lowercase at 19px ("name and phone", "demo notifications") rather than with a caption above it and with no page subtitle: account and sign-out with a 56px initial, "Name and phone" in 50px filled fields, and "Demo notifications" (`#notifications`) with one switch.

**Landing demo** (`web/components/landing-demo.tsx`). The landing page shows the classroom at window scale with the same classes: the "your classroom" title with the activity controls under it (Thumbs up, Change activity, End, refresh; drawn, not interactive) and the To review pill (and rail badge) lighting up when Cues asks; CAMERA beside ATTENTION; the four student cards underneath. The camera is an illustration of the vision overlay: one outlined box and name tag per person, tinted by status, never video. Each simulated student is drawn as a sign-in companion character in its own shape and color (Michelle a teal capsule, Keith a coral cube, Evan the indigo sphere, Eric an amber trapezoid), each with its own animation seed and neutral eyes that glance around independently (`CuesBlob` `shape`, `color`, `glance`, `seed`), so no two move together; the characters never act out a mood, and the box carries the status. The four-step script (start, Michelle finishes, Keith needs a check in, the teacher closes it) is unchanged and holds the third step under reduced motion. Camera tags show the name only and never run past their box. It is labelled "Simulated students" for screen readers and in the step captions under it.

**Tasks on the website.** The site offers only the built-in tasks, raised hand and thumbs up; it does not advertise custom or teacher-recorded gestures. The landing hero reads "Cues watches for raised hands, thumbs up and who keeps trying", three inline pills; "who keeps trying" is Cues' stalled-progress check, not a claim about how a child feels.

**Background gradient.** Workspace pages (classroom, To review, Profile) sit on a large, soft, blurred glow of periwinkle, lavender and a hint of mint, fixed behind the content (`.dashboard-shell::before`), as in the Figma Make reference. It is static. Night uses it at 55% strength.

**Alignment.** The title, activity controls, camera, Attention, student row, review cards and Profile cards all share the page gutter (`clamp(20px, 4vw, 48px)` from the rail). Right-side header pills end on the same edge as the panels and cards below them and sit on the title's center line. The CAMERA and ATTENTION headings share one height and one style: 13px, semibold, uppercase with 0.12em spacing. Page titles stay large lowercase Garamond.

## Shapes

Corners are concentric: an outer radius equals the inner radius plus the padding. A 28px panel holds 16px rows with 12px of padding. Buttons are full pills; icon buttons and avatars are circles.

## Motion

- Buttons scale to 0.96 when pressed (150ms, ease-out). Disabled buttons do not scale.
- On first load, the title, activity controls, camera and list arrive 100ms apart: opacity, 12px rise and 4px blur over 300ms. On Profile the title arrives, then the cards 60ms apart (120, 180, 240ms).
- Something new in a list (a request in ATTENTION, a person coming into view in the student row, a To review card) fades and rises 8px once (the student row slides in 8px from the side), 250ms with `cubic-bezier(0.23, 1, 0.32, 1)`, using `@starting-style` so nothing replays on later updates.
- An opened request, a person opened in the side panel, and the alert opt-in step fade and move 6px into place over 200–220ms. "Profile saved" and test-message lines fade in.
- High-frequency actions (hover, typing, the activity picker, switching tabs) stay instant.
- Under reduced motion, these become opacity-only fades.
- An opened row fades and rises 6px over 200ms.
- Hover styles apply only on hover-capable pointers.
- Under `prefers-reduced-motion: reduce`, movement and blur are removed.
- The theme toggle turns transitions off for the swap so colors change at once.
- After a switch (not on page load) the theme icon cross-fades in: scale 0.25→1, blur 4px→0, 300ms; opacity only under reduced motion.
- On the landing page, a button's arrow leans 2px toward its target on hover (real pointers only, with `web.landing_motion`).
- Headings use `text-wrap: balance` and paragraphs `text-wrap: pretty` site-wide.
- Header controls are a matched pair everywhere: a 40px round theme switch beside a pill (Get Started on the landing page, Sign up / Log in on the sign-in pages).
- Landing copy is Title Case with small words (a, the, or, for, to, by…) in lower case.
- **Landing hero glow drift.** The blurred glow behind the landing headline (`.ln-hero::before`) slowly turns and swells (`ln-drift`: up to 8° rotation, 1.08 scale, starting from the untransformed glow, a few percent of travel, 26s each way, `cubic-bezier(0.77, 0, 0.175, 1)`, alternating). Transform only. It runs only with `web.landing_motion`, only while the hero is on screen in a visible tab (`landing-ambient.tsx` sets `data-drift`; otherwise the animation pauses in place), and never under reduced motion. The landing page's main navy background does not move.
- The logo does not move between the landing and sign-in pages: both headers are 72px tall with a `clamp(16px, 4vw, 40px)` side gutter and a 28px mark.

## The Cues companion

The ball on the sign-in pages (`web/components/cues-blob.tsx`) uses the workspace palette rather than a flat accent: an indigo body (`#5763d2`) that leans toward the lavender in the page glow, a pale lavender rim (`#cdc8f6`), dark grain in the workspace navy (`#1d2a6a`) and a lavender drop shadow on Night. It is decorative and hidden from screen readers.

## Sign-in background

The sign-in pages (`/login`, `/signup`, `/auth/confirmed`) have a faint 22px dot grid (`.auth-page::before` in `web/components/auth.css`): 1px dots at 13% ink on light and 12% white on Night. A radial mask fades it out behind the companion and the question, so it only shows toward the edges. It does not move. The classroom stays plain.

## Color rules

- **Text names the state.** Status pills always carry a word (Working, Finished, Check in, Urgent). Color only supports the word.
- **Blue** marks Working. **Green** marks Finished and "All clear". **Warm brown** marks requests and Urgent. No color implies a learner's feelings or ability.

## Product boundaries the design keeps

- Video stays on the laptop. The browser reads the loopback stream directly, and no frame passes through the app server or Supabase.
- No expression labels or scores appear in the teacher's panels. The agent's rationale (behind "Why did Cues ask?") is free text written under the agent's no-diagnosis, no-internal-state rules; the dashboard does not filter it.
- Teacher decisions go through the `resolve_teacher_review` RPC (remote procedure call). The dashboard does not hide reviews locally as a stand-in for a decision.
- People are named as the backend names them ("Person 1"). Only simulated students are used.

## Removed in this redesign

- **`/live`** now redirects to `/dashboard`. Its people, counts and review decision now live on Classroom. Its "decision noted on this screen only" path is gone, because a decision that is not saved contradicts the review model.
- **`/settings/notifications`** said "Coming soon" although Photon alerts already work. It now redirects to `/settings/profile#notifications`.
- **Room view, "Who needs you next" card and "Last hour" timeline.** The timeline plotted only pending reviews, so resolved items disappeared and it read like history when it was not.
- **Raw station, session and owner IDs** in the session controls.
- **The numbers row** (In view, Working, Finished, Need you). The Class list already shows each of these: the Needs you group and its count, each person's status pill, and who is in view.
- **Camera pairing.** `/settings/stations` (a pairing-code form) now redirects to `/dashboard`. A teacher's classroom is created on first sign-in, and the dashboard tells this laptop's vision service which classroom it belongs to (`POST 127.0.0.1:8000/config`), so a code adds nothing. The Supabase pairing RPC is left in place; no schema change.
- **Flags `web.room_view` and `web.live_view`.** Their features no longer exist.
