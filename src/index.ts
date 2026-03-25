#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

const server = new McpServer({
  name: "mcp-server-databaze-rozhodnuti",
  version: "1.0.0",
});

// Tool 1: List available years
server.tool(
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
server.tool(
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
server.tool(
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
server.tool(
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
server.tool(
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
server.tool(
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

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server databaze-rozhodnuti started");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
