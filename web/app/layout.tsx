import Link from "next/link";
import { ConnectBar } from "./connect-bar";
import { DemoNav } from "./demo-nav";
import { Providers } from "./providers";
import "@dogeos/dogeos-sdk/style.css";
import "./globals.css";

export const metadata = {
  title: "DogeOS Demos",
  description: "Small integration examples on DogeOS Chikyu.",
  icons: { icon: "/brand/doge.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="partner-demo-shell">
            <a className="skip-link" href="#main">Skip to demos</a>
            <header>
              <Link className="wordmark" href="/" aria-label="DogeOS demos home">
                <img src="/brand/doge.png" alt="" width="32" height="32" />
                <img src="/brand/wordmark.svg" alt="" width="86" height="18" />
                <span>Demos</span>
              </Link>
              <span className="network">Chikyū testnet</span>
            </header>
            <ConnectBar />
            <DemoNav />
            <main id="main">{children}</main>
            <footer>Testnet examples · <a href="https://github.com/DogeOS69/onchain-demo-partner/tree/feat/partner-aa-sponsorship">Source</a></footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
