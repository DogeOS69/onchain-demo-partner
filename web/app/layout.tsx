import { Providers } from "./providers";
import "@dogeos/dogeos-sdk/style.css";
import "./globals.css";

export const metadata = {
  title: "DogeOS Onchain Quest Demo",
  description: "Trigger demo actions to drive on-chain quest verification.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="partner-demo-shell">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
