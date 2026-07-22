import { useRef } from 'react';
import type { RefObject } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { prefersReducedMotion } from './useIgnition.ts';

gsap.registerPlugin(useGSAP, ScrollTrigger);

if (typeof window !== 'undefined') {
  ScrollTrigger.disable();
}

let activeRevealScopes = 0;

function activateRevealScope(): () => void {
  if (activeRevealScopes === 0) {
    ScrollTrigger.enable();
  }

  activeRevealScopes += 1;

  return () => {
    activeRevealScopes -= 1;

    if (activeRevealScopes === 0) {
      ScrollTrigger.disable();
    }
  };
}

interface RevealOptions {
  itemSelector?: string;
}

export function useReveal<T extends HTMLElement = HTMLElement>({
  itemSelector,
}: RevealOptions = {}): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const reduceMotion = prefersReducedMotion();

  useGSAP(
    () => {
      const node = ref.current;
      if (!node || reduceMotion) {
        if (activeRevealScopes === 0) {
          ScrollTrigger.disable();
        }

        return;
      }

      const deactivateRevealScope = activateRevealScope();
      const targets = itemSelector ? gsap.utils.toArray<HTMLElement>(itemSelector, node) : [node];

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

      return deactivateRevealScope;
    },
    { scope: ref, dependencies: [itemSelector, reduceMotion], revertOnUpdate: true },
  );

  return ref;
}
