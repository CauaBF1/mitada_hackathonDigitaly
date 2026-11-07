export interface ReputationIndicationInput {
  supplier_domain?: unknown;
  company_name?: unknown;
  title?: unknown;
  url?: unknown;
  excerpt?: unknown;
  snippet?: unknown;
  observed_at?: unknown;
  timestamp?: unknown;
}

export function mapReputationIndications(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item: ReputationIndicationInput) => {
    if (!item || typeof item.url !== "string") return [];
    const excerpt = typeof item.excerpt === "string" ? item.excerpt : typeof item.snippet === "string" ? item.snippet : typeof item.title === "string" ? item.title : "";
    return [{
      supplier_domain: typeof item.supplier_domain === "string" ? item.supplier_domain : null,
      company_name: typeof item.company_name === "string" ? item.company_name : typeof item.title === "string" ? item.title : null,
      title: typeof item.title === "string" ? item.title : null,
      url: item.url,
      excerpt,
      observed_at: typeof item.observed_at === "string" ? item.observed_at : typeof item.timestamp === "string" ? item.timestamp : null,
    }];
  });
}

export function frontendStatus(status: unknown, quoteCount: number): "DONE" | "CALLING" | "NEGOTIATING" | "TODO" {
  if (status === "decidida" || status === "concluida") return "DONE";
  if (status === "pesquisando" || status === "recebida") return "CALLING";
  return quoteCount ? "NEGOTIATING" : "TODO";
}

export function reputationMatchesOrigin(reputationDomain: string, origin: string, isResearchOffer: boolean): boolean {
  const domain = reputationDomain.toLowerCase().replace(/^www\./, "");
  const host = origin.toLowerCase().replace(/^www\./, "");
  return isResearchOffer && !!domain && (host === domain || host.endsWith(`.${domain}`));
}
