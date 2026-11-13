"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const demos = [
  ["/external", "External rule"],
  ["/onchain", "Onchain rule"],
  ["/randomness", "Randomness"],
  ["/sponsorship", "Gas sponsorship"],
];

export function DemoNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Demos">
      {demos.map(([href, title]) => (
        <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>
          {title}
        </Link>
      ))}
    </nav>
  );
}
