# Welcome and Support motion refresh — design (2026-07-21)

Status: **approved for implementation**.

## Goal

Make the public Welcome page more informative and engaging, and make the signed-in
Support & FAQs page easier to scan. Preserve Switchboard's existing Operator Grid
visual system, keyboard-first behavior, dark/light themes, and accessibility rules.

## Audience split

- `/welcome` serves prospective customers and explains the product, outcomes,
  integrations, security, and workflow before sign-in.
- `/help` serves signed-in reps and admins with factual operating guidance and
  troubleshooting.

The pages may link to existing product routes, but they do not duplicate each
other's content or introduce a public help center.

## Welcome content

Keep the existing hero, live product frame, account band, feature acts, keyboard
strip, compliance line, and footer CTA. Add one concise workflow section that shows:

1. Connect a Gmail inbox.
2. Let Switchboard prioritize replies, tasks, and calls.
3. Contact leads through email, calling, SMS, and sequences while every touch lands
   on the shared timeline.

Expand the supporting copy around the existing feature acts to cover connected
inboxes, calling, SMS, sequences, shared history, compliance enforcement, and
role-based access. All claims must match behavior already documented or implemented
in the repository. No invented customer logos, metrics, integrations, or support
channels.

## Support and FAQ content

Group factual answers under:

- Account and inboxes
- Daily workflow
- Calling and messaging
- Compliance
- Admin support

Use native `<details>` and `<summary>` elements for disclosure behavior. Answers
cover Gmail connect, reconnect, disconnect, and sync status; shared timelines;
Smart Views; calls, SMS, and sequences; quiet hours, DNC, unsubscribe, bounce, and
recording consent; roles, settings, audit history, and escalation to a workspace
admin. Keep internal links to existing routes where they help the user act.

## Motion

- Keep Lenis scoped to `/welcome`; never add it to the signed-in app shell.
- Add `gsap` and `@gsap/react` because GSAP was explicitly requested and is not
  installed today. Use the official scoped `useGSAP` pattern and automatic cleanup.
- Use one restrained Welcome entrance timeline and ScrollTrigger choreography for
  the workflow story and feature acts. Motion explains progression; it does not run
  perpetually or animate every section.
- Prefer transforms and opacity. Keep UI feedback below 300ms and storytelling
  entrances within 800ms.
- Under `prefers-reduced-motion`, skip Lenis and spatial GSAP movement while leaving
  all content visible and usable.
- Support disclosures use native behavior plus existing CSS tokens only; no GSAP or
  smooth scrolling inside `/help`.

## Architecture

- Keep Welcome copy in `features/welcome/copy.ts` and presentational sections in the
  existing Welcome feature folder.
- Add only the smallest local motion hook/component needed to keep `WelcomePage`
  readable. GSAP selectors must be scoped to a page ref.
- Keep FAQ content as mapped data near `HelpPage`; split it only if the page would
  exceed the repository's file-size guidance.
- Reuse existing typography, color, spacing, state lamps, icons, keyboard components,
  and route links. No new design system or generic animation abstraction.

## Accessibility and responsive behavior

- Preserve semantic heading order, skip navigation, visible focus, and keyboard
  operation.
- Native FAQ summaries remain focusable and expose expanded state without custom
  ARIA scripting.
- Content is fully visible without JavaScript animation and under reduced motion.
- Verify desktop and mobile layouts in both themes with no clipping or overlap.

## Testing and verification

- Update Welcome tests for the new workflow content, route links, and reduced-motion
  behavior.
- Add focused Help tests for categories, disclosure interaction, real account setup
  guidance, internal links, and serious/critical accessibility violations.
- Run the affected web tests, typecheck, lint, and production build using the
  repository's existing commands.
- Manually click through `/welcome` and `/help` in the rendered app on desktop and
  mobile when the in-app browser is available. Record that gate as blocked if the
  browser runtime remains unavailable.

## Non-goals

- Public ticketing, live chat, external help-desk URLs, CMS-managed FAQs, FAQ search,
  video, stock imagery, invented testimonials, or additional motion libraries.
- Backend, database, authentication, or API contract changes.

