import type { JSX } from 'react';
import { HELP_GROUPS } from './helpContent.tsx';
import { Page } from './Page.tsx';

export function HelpPage(): JSX.Element {
  return (
    <Page
      title="Support & FAQs"
      subtitle="How Switchboard behaves, why it sometimes says no, and where to get help."
    >
      <div className="sb-help">
        <nav className="sb-help__topics" aria-label="Help topics">
          {HELP_GROUPS.map((group) => (
            <a key={group.id} href={'#help-' + group.id}>
              {group.title}
            </a>
          ))}
        </nav>
        {HELP_GROUPS.map((group) => (
          <section key={group.id} id={'help-' + group.id} className="sb-help__section">
            <h2 className="sb-help__section-title">{group.title}</h2>
            <p className="sb-help__lede">{group.intro}</p>
            <div className="sb-help__faq">
              {group.items.map((item) => (
                <details key={item.question} className="sb-help__faq-item">
                  <summary className="sb-help__q">{item.question}</summary>
                  <div className="sb-help__a">{item.answer}</div>
                </details>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Page>
  );
}
