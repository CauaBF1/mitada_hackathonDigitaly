import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexo | Compras autônomas",
  description: "Negociação inteligente, fornecedores com histórico e economia verificável em cada compra.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
