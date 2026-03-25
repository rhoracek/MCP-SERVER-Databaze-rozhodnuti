#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

const BASE_URL = "https://rozhodnuti.justice.cz";
const API_BASE = `${BASE_URL}/api/opendata`;

interface ApiYear {
  rok: number;
  pocetRozhodnuti: number;
  url: string;
}

interface ApiMonth {
  mesic: number;
  pocetRozhodnuti: number;
  url: string;
}

interface ApiDay {
  den: number;
  pocetRozhodnuti: number;
  url: string;
}

interface ApiDecisionSummary {
  idDokumentu: string;
  spisovaZnacka: string;
  ecli: string;
  datumVydani: string;
  nazevSoudu: string;
  url: string;
}

interface ApiDecisionDetail {
  idDokumentu: string;
  spisovaZnacka: string;
  ecli: string;
  datumVydani: string;
  nazevSoudu: string;
  predmetRizeni: string;
  klicovaSlova: string[];
  dotcenaUstanoveni: string[];
  vyrokAOduvodneni: string;
}

interface DayResponse {
  den: number;
  mesic: number;
  rok: number;
  pocetRozhodnuti: number;
  rozhodnuti: ApiDecisionSummary[];
  dalsiStranka?: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "mcp-server-databaze-rozhodnuti/1.0.0",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
  }

  return response.json() as Promise<T>;
}

// --- Helpers for text analysis ---

/** Extract legal provisions (§ references) from Czech legal text */
function extractProvisions(text: string): string[] {
  const patterns = [
    // § 123 odst. 1 písm. a) zákona č. 40/2009 Sb.
    /§\s*\d+[a-z]?(?:\s+odst\.\s*\d+)?(?:\s+písm\.\s*[a-z]\))?(?:\s+(?:zákona|zák\.|z\.)\s*č\.\s*\d+\/\d+\s*Sb\.)?/gi,
    // § 123 odst. 1 tr. zákoníku / občanského zákoníku / etc.
    /§\s*\d+[a-z]?(?:\s+odst\.\s*\d+)?(?:\s+písm\.\s*[a-z]\))?(?:\s+(?:tr\.|trestního|občanského|obchodního|správního|daňového|pracovního)\s+(?:zákoníku|zákon[a-z]*|řádu))/gi,
    // § 123 standalone
    /§\s*\d+[a-z]?(?:\s+odst\.\s*\d+)?(?:\s+písm\.\s*[a-z]\))?/g,
  ];

  const found = new Set<string>();
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) {
        found.add(m.trim().replace(/\s+/g, " "));
      }
    }
  }
  return [...found].sort();
}

/** Extract case file references (spisové značky) cited in text */
function extractCitations(text: string): string[] {
  // Matches patterns like: 1 T 14/2014, 25 Cdo 1234/2020, III. ÚS 456/21
  const pattern = /(?:(?:I{1,3}V?|VI{0,3})\.\s*ÚS|\d{1,3}\s+[A-Z][a-z]{0,4})\s+\d{1,5}\/\d{2,4}/g;
  const matches = text.match(pattern);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.trim()))];
}

/** Extract case type from spisová značka */
function extractCaseType(spisovaZnacka: string): string {
  // The registry mark (e.g. T, C, Cdo, Co, To, Az, etc.) identifies the case type
  const match = spisovaZnacka.match(/\d+\s+([A-Z][a-z]{0,4})\s+\d+/);
  if (match) return match[1];
  // Constitutional court format
  const usMatch = spisovaZnacka.match(/((?:I{1,3}V?|VI{0,3})\.\s*ÚS)/);
  if (usMatch) return usMatch[1];
  return "";
}

/** Fetch decision detail, returns null on failure */
async function fetchDecision(documentId: string): Promise<ApiDecisionDetail | null> {
  try {
    return await fetchJson<ApiDecisionDetail>(`${API_BASE}/detail/${documentId}`);
  } catch {
    return null;
  }
}

/** Split text into sections by common Czech legal decision structure */
function splitDecisionSections(text: string): {
  skutkovyStav: string;
  pravniOtazka: string;
  zaver: string;
} {
  const lower = text.toLowerCase();

  // Try to find factual state section
  let skutkovyStav = "";
  const factPattern = /(?:skutkov[ýé]\s+st[aá]v|ze\s+skutkov[ýé]ch\s+zjištění|soud\s+(?:prvního\s+stupně\s+)?zjistil|(?:z\s+)?(?:proveden[ée]ho\s+)?dokazování\s+(?:vyplynulo|vyplývá))[:\s]*([\s\S]{100,3000}?)(?=(?:právní\s+(?:posouzení|hodnocení|otázk)|(?:po\s+)?právní\s+stránce|soud\s+(?:proto\s+)?(?:dospěl|uzavřel|konstatoval)|odvolací\s+soud|(?:na\s+základě|vzhledem\s+k)\s+(?:výše\s+)?uveden))/i;
  const factMatch = text.match(factPattern);
  if (factMatch) {
    skutkovyStav = factMatch[1].trim();
  } else {
    // Fallback: first meaningful paragraph after "Odůvodnění:" or beginning
    const afterOduvodneni = text.replace(/^[\s\S]*?(?:odůvodnění|O\s*d\s*ů\s*v\s*o\s*d\s*n\s*ě\s*n\s*í)[:\s]*/i, "");
    const paragraphs = afterOduvodneni.split(/\n\s*\n/).filter((p) => p.trim().length > 50);
    skutkovyStav = paragraphs.slice(0, 3).join("\n\n").substring(0, 2000);
  }

  // Try to find legal question
  let pravniOtazka = "";
  const legalPatterns = /(?:právní\s+(?:posouzení|hodnocení|otázk[au])|(?:po\s+)?právní\s+stránce|k\s+(?:právní(?:mu)?|hmotněprávní(?:mu)?)\s+(?:posouzení|hodnocení))[:\s]*([\s\S]{50,2000}?)(?=(?:soud\s+(?:proto\s+)?(?:dospěl|uzavřel|rozhodl)|závěrem|(?:s\s+)?ohledem\s+na\s+(?:výše\s+)?uveden|ze?\s+(?:všech\s+)?(?:výše\s+)?uveden[ýé]ch\s+důvodů|poučení))/i;
  const legalMatch = text.match(legalPatterns);
  if (legalMatch) {
    pravniOtazka = legalMatch[1].trim();
  }

  // Try to find conclusion
  let zaver = "";
  const conclusionPatterns = /(?:(?:ze?\s+(?:všech\s+)?(?:výše\s+)?uveden[ýé]ch\s+důvodů|závěrem|soud\s+proto\s+(?:rozhodl|dospěl\s+k\s+závěru))[:\s]*([\s\S]{50,1500}?)(?=(?:poučení|p\s*o\s*u\s*č\s*e\s*n\s*í)|$))/i;
  const conclusionMatch = text.match(conclusionPatterns);
  if (conclusionMatch) {
    zaver = conclusionMatch[1].trim();
  }

  return { skutkovyStav, pravniOtazka, zaver };
}

const server = new McpServer({
  name: "mcp-server-databaze-rozhodnuti",
  version: "1.0.0",
});

function registerTools(srv: McpServer) {

// Tool 1: List available years
srv.tool(
  "list_years",
  "List all available years with court decision counts from the Czech court decisions database (rozhodnuti.justice.cz)",
  {},
  async () => {
    try {
      const data = await fetchJson<ApiYear[]>(API_BASE);
      const text = data
        .map((y) => `${y.rok}: ${y.pocetRozhodnuti} rozhodnutí`)
        .join("\n");
      return {
        content: [{ type: "text", text: text || "No data available." }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: List months in a year
srv.tool(
  "list_months",
  "List all months with court decision counts for a given year",
  {
    year: z.number().int().min(2000).max(2030).describe("Year (e.g. 2024)"),
  },
  async ({ year }) => {
    try {
      const data = await fetchJson<ApiMonth[]>(`${API_BASE}/${year}`);
      const text = data
        .map((m) => `${year}-${String(m.mesic).padStart(2, "0")}: ${m.pocetRozhodnuti} rozhodnutí`)
        .join("\n");
      return {
        content: [{ type: "text", text: text || "No data for this year." }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: List days in a month
srv.tool(
  "list_days",
  "List all days with court decision counts for a given year and month",
  {
    year: z.number().int().min(2000).max(2030).describe("Year (e.g. 2024)"),
    month: z.number().int().min(1).max(12).describe("Month (1-12)"),
  },
  async ({ year, month }) => {
    try {
      const data = await fetchJson<ApiDay[]>(`${API_BASE}/${year}/${month}`);
      const text = data
        .map(
          (d) =>
            `${year}-${String(month).padStart(2, "0")}-${String(d.den).padStart(2, "0")}: ${d.pocetRozhodnuti} rozhodnutí`
        )
        .join("\n");
      return {
        content: [{ type: "text", text: text || "No data for this month." }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: List decisions on a specific day
srv.tool(
  "list_decisions",
  "List all court decisions published on a specific date. Returns basic info including file reference (spisová značka), ECLI, court name, and link to detail.",
  {
    year: z.number().int().min(2000).max(2030).describe("Year (e.g. 2024)"),
    month: z.number().int().min(1).max(12).describe("Month (1-12)"),
    day: z.number().int().min(1).max(31).describe("Day (1-31)"),
    page: z.number().int().min(1).optional().describe("Page number for pagination (100 decisions per page)"),
  },
  async ({ year, month, day, page }) => {
    try {
      let url = `${API_BASE}/${year}/${month}/${day}`;
      if (page && page > 1) {
        url += `?stranka=${page}`;
      }
      const data = await fetchJson<DayResponse>(url);
      const lines = [
        `Date: ${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        `Total decisions: ${data.pocetRozhodnuti}`,
        "",
      ];
      if (data.rozhodnuti && data.rozhodnuti.length > 0) {
        for (const r of data.rozhodnuti) {
          lines.push(`- ${r.spisovaZnacka} | ${r.ecli}`);
          lines.push(`  Court: ${r.nazevSoudu}`);
          lines.push(`  Date: ${r.datumVydani}`);
          lines.push(`  ID: ${r.idDokumentu}`);
          lines.push("");
        }
      } else {
        lines.push("No decisions found for this date.");
      }
      if (data.dalsiStranka) {
        lines.push(`Next page available: ${data.dalsiStranka}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool 5: Get decision detail by ID
srv.tool(
  "get_decision",
  "Get the full detail of a specific court decision by its document ID, including the ruling text, keywords, and referenced legal provisions.",
  {
    documentId: z.string().describe("Document ID of the decision (idDokumentu from list_decisions)"),
  },
  async ({ documentId }) => {
    try {
      const url = `${API_BASE}/detail/${documentId}`;
      const data = await fetchJson<ApiDecisionDetail>(url);
      const lines = [
        `File reference: ${data.spisovaZnacka}`,
        `ECLI: ${data.ecli}`,
        `Date: ${data.datumVydani}`,
        `Court: ${data.nazevSoudu}`,
        `Subject: ${data.predmetRizeni || "N/A"}`,
        "",
      ];
      if (data.klicovaSlova && data.klicovaSlova.length > 0) {
        lines.push(`Keywords: ${data.klicovaSlova.join(", ")}`);
      }
      if (data.dotcenaUstanoveni && data.dotcenaUstanoveni.length > 0) {
        lines.push(`Legal provisions: ${data.dotcenaUstanoveni.join(", ")}`);
      }
      lines.push("");
      lines.push("--- Decision text ---");
      lines.push(data.vyrokAOduvodneni || "No text available.");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool 6: Search decisions via the web search endpoint
srv.tool(
  "search_decisions",
  "Search court decisions by text query, file reference (spisová značka), court name, or date range. Uses the web search interface of rozhodnuti.justice.cz.",
  {
    query: z.string().optional().describe("Full-text search query"),
    spisovaZnacka: z.string().optional().describe("File reference number (e.g. '1 T 14/2014')"),
    nazevSoudu: z.string().optional().describe("Court name filter"),
    datumOd: z.string().optional().describe("Date from (format: YYYY-MM-DD)"),
    datumDo: z.string().optional().describe("Date to (format: YYYY-MM-DD)"),
    page: z.number().int().min(1).optional().describe("Page number"),
  },
  async ({ query, spisovaZnacka, nazevSoudu, datumOd, datumDo, page }) => {
    try {
      const params = new URLSearchParams();
      if (query) params.set("dotaz", query);
      if (spisovaZnacka) params.set("spisovaZnacka", spisovaZnacka);
      if (nazevSoudu) params.set("nazevSoudu", nazevSoudu);
      if (datumOd) params.set("datumOd", datumOd);
      if (datumDo) params.set("datumDo", datumDo);
      if (page && page > 1) params.set("stranka", String(page));

      const url = `${BASE_URL}/api/rozhodnuti?${params.toString()}`;
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "mcp-server-databaze-rozhodnuti/1.0.0",
        },
      });

      if (!response.ok) {
        // Fallback: try the opendata search if the search API is not available
        return {
          content: [
            {
              type: "text",
              text: `The search API returned HTTP ${response.status}. The rozhodnuti.justice.cz search API may not be publicly available. Please use the date-based browsing tools (list_years, list_months, list_days, list_decisions) to browse decisions by date, or visit ${BASE_URL} directly to search via the web interface.`,
            },
          ],
        };
      }

      const data = await response.json();
      return {
        content: [
          { type: "text", text: JSON.stringify(data, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool 7: Get cited provisions from a decision
srv.tool(
  "get_cited_provisions",
  "Extract all legal provisions (§ references) cited in a court decision. Returns structured list of all referenced paragraphs, articles, and laws found in the decision text.",
  {
    documentId: z.string().describe("Document ID of the decision"),
  },
  async ({ documentId }) => {
    try {
      const decision = await fetchDecision(documentId);
      if (!decision) {
        return {
          content: [{ type: "text", text: `Decision ${documentId} not found.` }],
          isError: true,
        };
      }

      const fullText = decision.vyrokAOduvodneni || "";
      const extracted = extractProvisions(fullText);

      // Combine API-provided provisions with text-extracted ones
      const apiProvisions = decision.dotcenaUstanoveni || [];
      const allProvisions = [...new Set([...apiProvisions, ...extracted])];

      const lines = [
        `Decision: ${decision.spisovaZnacka} (${decision.ecli})`,
        `Court: ${decision.nazevSoudu}`,
        `Date: ${decision.datumVydani}`,
        "",
        `=== Legal provisions from metadata (${apiProvisions.length}) ===`,
        ...apiProvisions.map((p) => `  • ${p}`),
        "",
        `=== Legal provisions extracted from text (${extracted.length}) ===`,
        ...extracted.map((p) => `  • ${p}`),
        "",
        `Total unique provisions: ${allProvisions.length}`,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool 8: Get related decisions
srv.tool(
  "get_related_decisions",
  "Find related court decisions based on: (1) same legal provisions (§), (2) same case type (registry mark), (3) decisions cited in the text. Analyzes the given decision and searches for connections.",
  {
    documentId: z.string().describe("Document ID of the decision to find relations for"),
  },
  async ({ documentId }) => {
    try {
      const decision = await fetchDecision(documentId);
      if (!decision) {
        return {
          content: [{ type: "text", text: `Decision ${documentId} not found.` }],
          isError: true,
        };
      }

      const fullText = decision.vyrokAOduvodneni || "";
      const lines: string[] = [
        `Related decisions for: ${decision.spisovaZnacka} (${decision.ecli})`,
        `Court: ${decision.nazevSoudu}`,
        `Date: ${decision.datumVydani}`,
        "",
      ];

      // 1. Cited decisions (spisové značky found in text)
      const citations = extractCitations(fullText);
      lines.push(`=== Decisions cited in text (${citations.length}) ===`);
      if (citations.length > 0) {
        for (const c of citations) {
          lines.push(`  • ${c}`);
        }
      } else {
        lines.push("  (none found)");
      }
      lines.push("");

      // 2. Same legal provisions
      const provisions = decision.dotcenaUstanoveni || [];
      const extracted = extractProvisions(fullText);
      const allProvisions = [...new Set([...provisions, ...extracted])];
      lines.push(`=== Shared legal provisions (${allProvisions.length}) ===`);
      lines.push("  Decisions referencing the same provisions can be found by searching for:");
      for (const p of allProvisions.slice(0, 15)) {
        lines.push(`  • ${p}`);
      }
      if (allProvisions.length > 15) {
        lines.push(`  ... and ${allProvisions.length - 15} more`);
      }
      lines.push("");

      // 3. Same case type
      const caseType = extractCaseType(decision.spisovaZnacka);
      const caseTypeMap: Record<string, string> = {
        T: "trestní věci",
        C: "občanskoprávní věci",
        Cdo: "dovolání v civilních věcech",
        Co: "odvolání v civilních věcech",
        To: "odvolání v trestních věcech",
        Tdo: "dovolání v trestních věcech",
        Az: "azylové věci",
        A: "správní věci",
        As: "správní soudnictví",
        Ca: "správní žaloby",
        P: "opatrovnické věci",
        E: "výkon rozhodnutí / exekuce",
        Nc: "nesporná řízení",
        Nt: "trestní příkazy / vazba",
        ICm: "incidenční spory (insolvence)",
        KSPH: "krajský soud",
        ÚS: "ústavní stížnosti",
      };
      const caseTypeName = caseTypeMap[caseType] || caseType;
      lines.push(`=== Case type ===`);
      lines.push(`  Registry mark: ${caseType || "unknown"} (${caseTypeName})`);
      lines.push(`  Related decisions share the same registry mark in their spisová značka.`);
      lines.push("");

      // 4. Keywords overlap
      const keywords = decision.klicovaSlova || [];
      if (keywords.length > 0) {
        lines.push(`=== Keywords for finding related decisions ===`);
        for (const kw of keywords) {
          lines.push(`  • ${kw}`);
        }
        lines.push("");
      }

      // Summary
      lines.push(`=== Summary ===`);
      lines.push(`To find the most relevant related decisions:`);
      lines.push(`1. Search for cited file references: ${citations.slice(0, 5).join(", ") || "(none)"}`);
      lines.push(`2. Search for same provisions: ${allProvisions.slice(0, 3).join(", ") || "(none)"}`);
      lines.push(`3. Browse same case type "${caseType}" at the same court`);
      if (keywords.length > 0) {
        lines.push(`4. Search by keywords: ${keywords.slice(0, 5).join(", ")}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool 9: Summarize decision for judge
srv.tool(
  "summarize_decision_for_judge",
  "Generate a structured summary of a court decision for a judge. Returns: factual situation (skutkový stav), legal question (právní otázka), conclusion (závěr), relevant provisions, and potentially related case law.",
  {
    documentId: z.string().describe("Document ID of the decision"),
  },
  async ({ documentId }) => {
    try {
      const decision = await fetchDecision(documentId);
      if (!decision) {
        return {
          content: [{ type: "text", text: `Decision ${documentId} not found.` }],
          isError: true,
        };
      }

      const fullText = decision.vyrokAOduvodneni || "";
      const sections = splitDecisionSections(fullText);
      const provisions = decision.dotcenaUstanoveni || [];
      const extracted = extractProvisions(fullText);
      const allProvisions = [...new Set([...provisions, ...extracted])];
      const citations = extractCitations(fullText);
      const caseType = extractCaseType(decision.spisovaZnacka);
      const keywords = decision.klicovaSlova || [];

      const lines = [
        "╔══════════════════════════════════════════════════════════════╗",
        "║           STRUKTUROVANÝ SOUHRN ROZHODNUTÍ                  ║",
        "╚══════════════════════════════════════════════════════════════╝",
        "",
        `Spisová značka: ${decision.spisovaZnacka}`,
        `ECLI: ${decision.ecli}`,
        `Soud: ${decision.nazevSoudu}`,
        `Datum vydání: ${decision.datumVydani}`,
        `Předmět řízení: ${decision.predmetRizeni || "N/A"}`,
        `Typ věci: ${caseType || "N/A"}`,
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "1. SKUTKOVÝ STAV",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
        sections.skutkovyStav || "(Nepodařilo se automaticky extrahovat – viz plný text rozhodnutí)",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "2. PRÁVNÍ OTÁZKA",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
        sections.pravniOtazka || "(Nepodařilo se automaticky extrahovat – viz plný text rozhodnutí)",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "3. ZÁVĚR",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
        sections.zaver || "(Nepodařilo se automaticky extrahovat – viz plný text rozhodnutí)",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        `4. RELEVANTNÍ USTANOVENÍ (${allProvisions.length})`,
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
      ];

      if (allProvisions.length > 0) {
        for (const p of allProvisions) {
          lines.push(`  • ${p}`);
        }
      } else {
        lines.push("  (žádná ustanovení nenalezena)");
      }

      lines.push("");
      lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      lines.push(`5. MOŽNÉ SOUVISEJÍCÍ JUDIKÁTY (${citations.length})`);
      lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      lines.push("");

      if (citations.length > 0) {
        for (const c of citations) {
          lines.push(`  • ${c}`);
        }
      } else {
        lines.push("  (žádné citace jiných rozhodnutí nenalezeny v textu)");
      }

      if (keywords.length > 0) {
        lines.push("");
        lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        lines.push("KLÍČOVÁ SLOVA");
        lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        lines.push("");
        lines.push(`  ${keywords.join(", ")}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);

} // end registerTools

// Start the server
async function main() {
  const mode = process.env.MCP_TRANSPORT || "stdio";

  if (mode === "http") {
    const app = express();
    app.use(express.json());

    // Health check
    app.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });

    // Stateless HTTP transport - each request gets its own transport/server
    app.all("/mcp", async (req, res) => {
      const httpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      const httpServer = new McpServer({
        name: "mcp-server-databaze-rozhodnuti",
        version: "1.0.0",
      });
      registerTools(httpServer);
      await httpServer.connect(httpTransport);
      await httpTransport.handleRequest(req, res, req.body);
    });

    const port = parseInt(process.env.PORT || "3000", 10);
    app.listen(port, "0.0.0.0", () => {
      console.error(`MCP HTTP server listening on 0.0.0.0:${port}`);
    });
  } else {
    registerTools(server);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MCP server databaze-rozhodnuti started (stdio)");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
