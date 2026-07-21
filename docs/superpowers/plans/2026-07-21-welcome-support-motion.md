# Welcome and Support Motion Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Subagent execution is unavailable for this repository task.

**Goal:** Expand the public Welcome story and signed-in Support guidance while adding restrained, accessible GSAP motion to the existing Lenis-powered landing page.

**Architecture:** Keep Welcome inside its current feature folder and add one presentational workflow section driven by copy data. Replace the current IntersectionObserver reveal internals with scoped useGSAP and ScrollTrigger. Help uses native disclosure elements and CSS only; no API, database, authentication, or route-contract changes.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Testing Library, Lenis, GSAP, @gsap/react, CSS custom properties.

## Global Constraints

- Preserve Operator Grid styling, routes, real product claims, themes, and keyboard access.
- Lenis and GSAP stay scoped to /welcome; the signed-in app shell gets neither.
- Add only gsap and @gsap/react.
- Reduced motion skips Lenis and spatial GSAP motion while all content remains visible.
- FAQs use native details and summary elements.
- Do not invent customers, metrics, integrations, testimonials, or support channels.
- Node >=24 and pnpm >=10 are the supported verification environment.
- Do not commit or push unless the user explicitly asks.

---

## File map

- Create apps/web/src/pages/helpContent.tsx for typed FAQ data.
- Create apps/web/src/pages/HelpPage.test.tsx for content, interaction, link, and axe coverage.
- Modify apps/web/src/pages/HelpPage.tsx and apps/web/src/app/shell.css for grouped disclosures.
- Create apps/web/src/features/welcome/WorkflowStory.tsx for the three-step product story.
- Modify Welcome copy, page, tests, feature acts, reveal hook, and CSS.
- Modify apps/web/package.json and pnpm-lock.yaml for GSAP.
- Modify docs/dev-notes.md with actual verification evidence.

---

### Task 1: Build factual, native Support disclosures

**Files:**
- Create: apps/web/src/pages/helpContent.tsx
- Create: apps/web/src/pages/HelpPage.test.tsx
- Modify: apps/web/src/pages/HelpPage.tsx
- Modify: apps/web/src/app/shell.css

**Interfaces:**
- Produces HELP_GROUPS: readonly HelpGroup[].
- HelpGroup has id, title, intro, and items.
- HelpItem has question and answer: ReactNode.

- [ ] **Step 1: Write the failing page tests**

Create a MemoryRouter renderHelp helper around HelpPage. Add these exact assertions:

    test('renders five real help categories as native disclosures', () => {
      const { container } = renderHelp();
      for (const name of [
        'Account and inboxes',
        'Daily workflow',
        'Calling and messaging',
        'Compliance',
        'Admin support',
      ]) {
        expect(screen.getByRole('heading', { name, level: 2 })).toBeInTheDocument();
      }
      expect(container.querySelectorAll('details.sb-help__faq-item')).toHaveLength(15);
      expect(screen.getByText(/disconnecting removes Switchboard's authorization/i)).toBeInTheDocument();
    });

    test('opens an answer through its native summary', async () => {
      const user = userEvent.setup();
      renderHelp();
      const summary = screen.getByText('How do I connect my Gmail inbox?').closest('summary');
      expect(summary).not.toBeNull();
      await user.click(summary as HTMLElement);
      expect(summary?.parentElement).toHaveAttribute('open');
    });

    test('links to existing action surfaces', () => {
      renderHelp();
      expect(screen.getByRole('link', { name: /Settings → Inboxes/i })).toHaveAttribute('href', '/settings');
      expect(screen.getByRole('link', { name: 'Smart Views' })).toHaveAttribute('href', '/views');
    });

Add the accessibility assertion:

    test('has no serious or critical axe violations', async () => {
      const { container } = renderHelp();
      const results = await axe.run(container, {
        rules: { 'color-contrast': { enabled: false } },
      });
      const blocking = results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      );
      expect(blocking.map((violation) => violation.id)).toEqual([]);
    });

- [ ] **Step 2: Prove the test fails**

Run:

    pnpm --filter @switchboard/web test -- src/pages/HelpPage.test.tsx

Expected: FAIL because the categories and disclosure markup do not exist.

- [ ] **Step 3: Add complete Help content**

Create helpContent.tsx with five groups and these exact questions and facts:

1. Account and inboxes
   - How do I connect my Gmail inbox? Link to Settings → Inboxes; the user approves Google consent and never supplies API keys.
   - What do the inbox statuses mean? Explain Live, Connecting, and Attention.
   - What happens when I disconnect or reconnect? Disconnect removes authorization and cursors but preserves imported mail; reconnect resumes safely.
2. Daily workflow
   - Where do emails, calls, texts, and notes appear? The shared append-only lead timeline.
   - What is a Smart View? A live saved query; link Smart Views to /views.
   - How do keyboard shortcuts work? Show ?, Ctrl K, and g then a rail letter with existing Kbd.
3. Calling and messaging
   - How do calls and SMS work? Link Dialer to /dialer and explain the shared timeline.
   - Why did my sequence stop? Reply, unsubscribe, DNC, or bounce pauses before claim.
   - Where do I manage sequences? Link Sequences to /sequences.
4. Compliance
   - Why can I not email or call this lead? Explain DNC, suppression, and consent checks at delivery.
   - Why is scheduled outbound waiting? Explain quiet hours and daily caps.
   - Are calls recorded? Off by default, admin-controlled, audited, and consent-announced.
5. Admin support
   - Who can change workspace settings? Admins; changes are audited.
   - Where are build and workspace details? Link Settings → About to /settings.
   - What if I am still blocked? Ask a workspace admin; no invented external help desk.

Use:

    export interface HelpItem {
      question: string;
      answer: ReactNode;
    }

    export interface HelpGroup {
      id: string;
      title: string;
      intro: string;
      items: readonly HelpItem[];
    }

Implement HELP_GROUPS as five objects in the order above. Each object uses the
listed title, a lowercase ASCII id (accounts, workflow, messaging, compliance,
admin), a one-sentence intro, and exactly three HelpItem objects containing the
fully written facts above. Use Link for the five existing route links and Kbd for
the three keyboard caps. This yields exactly fifteen disclosure items and no
duplicate copy inside HelpPage.

- [ ] **Step 4: Render topic links and disclosures**

HelpPage renders:

    <nav className="sb-help__topics" aria-label="Help topics">
      {HELP_GROUPS.map((group) => (
        <a key={group.id} href={'#help-' + group.id}>{group.title}</a>
      ))}
    </nav>

For each group render a section with id help-{id}, h2, intro, and:

    <details className="sb-help__faq-item">
      <summary className="sb-help__q">{item.question}</summary>
      <div className="sb-help__a">{item.answer}</div>
    </details>

Keep the existing Page title and subtitle.

- [ ] **Step 5: Style with existing shell tokens**

Keep the responsive readable-measure grid. Add a wrapping topic strip, square bordered links, pointer summary, native list-marker suppression, a plus/minus CSS marker, visible focus ring, and a 200ms answer fade/4px translate. Under prefers-reduced-motion set the answer animation to none. Do not animate height.

- [ ] **Step 6: Run focused Help checks**

    pnpm --filter @switchboard/web test -- src/pages/HelpPage.test.tsx src/app/rail.test.tsx

Expected: PASS; the rail still opens the real Support page.

---

### Task 2: Add the Welcome workflow story

**Files:**
- Create: apps/web/src/features/welcome/WorkflowStory.tsx
- Modify: apps/web/src/features/welcome/copy.ts
- Modify: apps/web/src/features/welcome/WelcomePage.tsx
- Modify: apps/web/src/features/welcome/WelcomePage.test.tsx
- Modify: apps/web/src/features/welcome/welcome.css

**Interfaces:**
- Produces WORKFLOW_STORY and WorkflowStory.
- Consumes useReveal and existing Welcome tokens.

- [ ] **Step 1: Add failing content tests**

    test('explains the connected workflow in three steps', () => {
      const { container } = renderWelcome();
      expect(screen.getByRole('heading', {
        name: 'From connected inbox to completed follow-up',
      })).toBeInTheDocument();
      expect(screen.getByText('Connect your Gmail inbox')).toBeInTheDocument();
      expect(screen.getByText('Work the next signal')).toBeInTheDocument();
      expect(screen.getByText('Keep every touch together')).toBeInTheDocument();
      expect(container.querySelectorAll('.sb-welcome__workflow-step')).toHaveLength(3);
    });

    test('the Workflow anchor points at the real section', () => {
      const { container } = renderWelcome();
      expect(screen.getByRole('link', { name: 'Workflow' }))
        .toHaveAttribute('href', '#welcome-workflow');
      expect(container.querySelector('#welcome-workflow')).not.toBeNull();
    });

- [ ] **Step 2: Prove the tests fail**

    pnpm --filter @switchboard/web test -- src/features/welcome/WelcomePage.test.tsx

Expected: FAIL because the section and nav anchor do not exist.

- [ ] **Step 3: Add auditable copy**

Add to copy.ts:

    export const WORKFLOW_STORY = {
      label: 'How it works',
      title: 'From connected inbox to completed follow-up',
      sub: 'One operating loop keeps the signal, the conversation, and the record together.',
      steps: [
        {
          number: '01',
          title: 'Connect your Gmail inbox',
          body: 'Authorize your own mailbox from Settings. Switchboard syncs the conversation without asking you for provider API keys.',
          meta: 'Owner-scoped · encrypted authorization',
        },
        {
          number: '02',
          title: 'Work the next signal',
          body: 'Replies, overdue tasks, calls, and active sequences are prioritized into one keyboard-driven queue.',
          meta: 'Inbox · Smart Views · shortcuts',
        },
        {
          number: '03',
          title: 'Keep every touch together',
          body: 'Email, calls, SMS, notes, and sequence outcomes land on the same shared lead timeline.',
          meta: 'One ordered history · team-visible',
        },
      ],
    } as const;

Add Workflow pointing to #welcome-workflow before Features in NAV_MENU.

- [ ] **Step 4: Build WorkflowStory**

Render a section with id welcome-workflow, an eyebrow, h2, subtitle, and an ordered list mapping the three steps. Give the section a useReveal ref configured with itemSelector .sb-welcome__workflow-step. Each step renders its number, h3, body, and mono metadata.

Insert WorkflowStory between AccountsBand and FeatureActs.

- [ ] **Step 5: Match the Operator Grid**

Add one max-width Welcome section using existing gutters. Use a three-column grid with 1px gaps and square panel surfaces. Numbers and metadata use the mono face; headings use the display face. At max-width 860px collapse to one column. Add no new colors, glows, gradients, or decorative imagery.

- [ ] **Step 6: Run the Welcome content tests**

Repeat the Step 2 command. Expected: PASS.

---

### Task 3: Move scroll reveals to scoped GSAP

**Files:**
- Modify: apps/web/package.json
- Modify: pnpm-lock.yaml
- Modify: apps/web/src/features/welcome/useReveal.ts
- Modify: apps/web/src/features/welcome/useReveal.test.tsx
- Modify: apps/web/src/features/welcome/FeatureActs.tsx
- Modify: apps/web/src/features/welcome/welcome.css

**Interfaces:**
- Produces useReveal<T>(options?: RevealOptions): RefObject<T | null>.
- RevealOptions has optional itemSelector: string.

- [ ] **Step 1: Install the two requested dependencies**

    pnpm --filter @switchboard/web add gsap @gsap/react

Expected: dependency entries only in apps/web/package.json and pnpm-lock.yaml.

- [ ] **Step 2: Write failing hook tests**

Mock gsap, gsap/ScrollTrigger, and @gsap/react. Make the useGSAP mock execute its callback. Assert normal motion calls gsap.from with:

    {
      opacity: 0,
      y: 12,
      duration: 0.48,
      ease: 'power3.out',
      stagger: 0,
      clearProps: 'transform,opacity',
      scrollTrigger: {
        trigger: expect.any(HTMLElement),
        start: 'top 82%',
        once: true,
      },
    }

For itemSelector, assert stagger is 0.08 and gsap.utils.toArray receives the selector and section node. For reduced motion, assert gsap.from is not called and the DOM remains visible.

- [ ] **Step 3: Prove the hook tests fail**

    pnpm --filter @switchboard/web test -- src/features/welcome/useReveal.test.tsx

Expected: FAIL because useReveal still uses IntersectionObserver.

- [ ] **Step 4: Implement the official React pattern**

Replace useReveal internals with:

    import { useRef } from 'react';
    import type { RefObject } from 'react';
    import gsap from 'gsap';
    import { ScrollTrigger } from 'gsap/ScrollTrigger';
    import { useGSAP } from '@gsap/react';
    import { prefersReducedMotion } from './useIgnition.ts';

    gsap.registerPlugin(useGSAP, ScrollTrigger);

    interface RevealOptions {
      itemSelector?: string;
    }

    export function useReveal<T extends HTMLElement = HTMLElement>(
      { itemSelector }: RevealOptions = {},
    ): RefObject<T | null> {
      const ref = useRef<T | null>(null);
      const reduceMotion = prefersReducedMotion();

      useGSAP(() => {
        const node = ref.current;
        if (!node || reduceMotion) return;
        const targets = itemSelector
          ? gsap.utils.toArray<HTMLElement>(itemSelector, node)
          : [node];

        gsap.from(targets, {
          opacity: 0,
          y: 12,
          duration: 0.48,
          ease: 'power3.out',
          stagger: itemSelector ? 0.08 : 0,
          clearProps: 'transform,opacity',
          scrollTrigger: {
            trigger: node,
            start: 'top 82%',
            once: true,
          },
        });
      }, { scope: ref, dependencies: [itemSelector, reduceMotion] });

      return ref;
    }

- [ ] **Step 5: Remove competing reveal state**

FeatureActs consumes only const ref = useReveal<HTMLElement>() and removes data-reveal. Remove the data-reveal opacity/transform CSS and matching reduced-motion override. Keep hero ignition, Lenis, layout transitions, and ambient lamp rules unchanged.

- [ ] **Step 6: Run motion and Welcome tests**

    pnpm --filter @switchboard/web test -- src/features/welcome/useReveal.test.tsx src/features/welcome/WelcomePage.test.tsx

Expected: PASS; reduced motion creates no GSAP tween.

---

### Task 4: Verify and document

**Files:**
- Modify: docs/dev-notes.md

- [ ] **Step 1: Run all focused tests**

    pnpm --filter @switchboard/web test -- src/pages/HelpPage.test.tsx src/app/rail.test.tsx src/features/welcome/useReveal.test.tsx src/features/welcome/WelcomePage.test.tsx

Expected: PASS.

- [ ] **Step 2: Run static and production checks**

    pnpm --filter @switchboard/web typecheck
    pnpm --filter @switchboard/web lint
    pnpm --filter @switchboard/web build
    pnpm exec prettier --check apps/web/src/pages apps/web/src/features/welcome apps/web/src/app/shell.css docs/superpowers
    git diff --check

Expected: exit 0. If the host remains on Node 22, record the engine warning and do not claim Node 24 verification.

- [ ] **Step 3: Perform the rendered click-through**

At desktop and mobile widths in both themes, verify /welcome Workflow navigation, full content visibility, Lenis, one-shot workflow/feature reveals, reduced motion, mobile menu, and console. Sign in and verify /help: open one item per category, follow Settings and Smart Views, tab through every summary, and check clipping. If the in-app browser remains unavailable, record the gate as blocked rather than substituting source inspection.

- [ ] **Step 4: Update development notes**

Append 2026-07-21 - Welcome and Support motion refresh using Completed, Files Changed, Decisions Made, How to Test, Verification Evidence, and Next Steps. Record only actual command results and actual browser status.

- [ ] **Step 5: Review the scoped diff without committing**

    git status --short
    git diff -- apps/web/src/pages apps/web/src/app/shell.css apps/web/src/features/welcome apps/web/package.json pnpm-lock.yaml docs/dev-notes.md docs/superpowers

Expected: only scoped work plus approved docs; unrelated dirty-tree changes remain untouched.
