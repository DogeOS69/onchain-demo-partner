import Link from "next/link";
import { LabProviders } from "./lab-providers";
import "@dogeos/dogeos-sdk/style.css";
import "./globals.css";

export const metadata = {
  title: "DogeOS 7702 Lab",
  description: "Self-funded EIP-7702 and ERC-4337 counter on DogeOS devnet.",
  icons: { icon: "/brand/doge.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <LabProviders>
          <div className="partner-demo-shell">
            <a className="skip-link" href="#main">Skip to demos</a>
            <header>
              <Link className="wordmark" href="/" aria-label="DogeOS demos home">
                <img src="/brand/doge.png" alt="" width="32" height="32" />
                <img src="/brand/wordmark.svg" alt="" width="86" height="18" />
                <span>Demos</span>
              </Link>
              <span className="network">7702 lab</span>
            </header>
            <main id="main">{children}</main>
            <footer>Devnet experiment · <a href="https://github.com/DogeOS69/onchain-demo-partner/tree/feat/partner-aa-7702">Source</a></footer>
          </div>
        </LabProviders>
      </body>
    </html>
  );
}
