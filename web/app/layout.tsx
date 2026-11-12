import Link from "next/link";
import { ConnectBar } from "./connect-bar";
import { Providers } from "./providers";
import "@dogeos/dogeos-sdk/style.css";
import "./globals.css";

export const metadata = {
  title: "DogeOS Demos",
  description: "Small integration examples on DogeOS Chikyu.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="partner-demo-shell"><header><Link className="wordmark" href="/">DogeOS <span>Demos</span></Link><span className="network">Chikyū testnet</span></header><ConnectBar /><nav aria-label="Demos"><Link href="/external">External rule</Link><Link href="/onchain">Onchain rule</Link><Link href="/randomness">Randomness</Link><Link href="/sponsorship">Gas sponsorship</Link></nav><main>{children}</main><footer>Testnet examples · <a href="https://github.com/DogeOS69/onchain-demo-partner/tree/feat/partner-aa-sponsorship">Source</a></footer></div>
        </Providers>
      </body>
    </html>
  );
}
