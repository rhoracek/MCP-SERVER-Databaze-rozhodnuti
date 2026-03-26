#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = "https://rozhodnuti.justice.cz";
const API_BASE = `${BASE_URL}/api/opendata`;

// --- Interfaces ---

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

// --- Core helpers ---

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

async function fetchDecision(documentId: string): Promise<ApiDecisionDetail | null> {
  try {
    return await fetchJson<ApiDecisionDetail>(`${API_BASE}/detail/${documentId}`);
  } catch {
    return null;
  }
}

function extractProvisions(text: string): string[] {
  const patterns = [
    /§\s*\d+[a-z]?(?:\s+odst\.\s*\d+)?(?:\s+písm\.\s*[a-z]\))?(?:\s+(?:zákona|zák\.|z\.)\s*č\.\s*\d+\/\d+\s*Sb\.)?/gi,
    /§\s*\d+[a-z]?(?:\s+odst\.\s*\d+)?(?:\s+písm\.\s*[a-z]\))?(?:\s+(?:tr\.|trestního|občanského|obchodního|správního|daňového|pracovního)\s+(?:zákoníku|zákon[a-z]*|řádu))/gi,
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

function extractCitations(text: string): string[] {
  const pattern = /(?:(?:I{1,3}V?|VI{0,3})\.\s*ÚS|\d{1,3}\s+[A-Z][a-z]{0,4})\s+\d{1,5}\/\d{2,4}/g;
  const matches = text.match(pattern);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.trim()))];
}

function extractCaseType(spisovaZnacka: string): string {
  const match = spisovaZnacka.match(/\d+\s+([A-Z][a-z]{0,4})\s+\d+/);
  if (match) return match[1];
  const usMatch = spisovaZnacka.match(/((?:I{1,3}V?|VI{0,3})\.\s*ÚS)/);
  if (usMatch) return usMatch[1];
  return "";
}

const CASE_TYPE_MAP: Record<string, string> = {
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
  ÚS: "ústavní stížnosti",
};

function splitDecisionSections(text: string) {
  let skutkovyStav = "";
  const factPattern = /(?:skutkov[ýé]\s+st[aá]v|ze\s+skutkov[ýé]ch\s+zjištění|soud\s+(?:prvního\s+stupně\s+)?zjistil|(?:z\s+)?(?:proveden[ée]ho\s+)?dokazování\s+(?:vyplynulo|vyplývá))[:\s]*([\s\S]{100,3000}?)(?=(?:právní\s+(?:posouzení|hodnocení|otázk)|(?:po\s+)?právní\s+stránce|soud\s+(?:proto\s+)?(?:dospěl|uzavřel|konstatoval)|odvolací\s+soud|(?:na\s+základě|vzhledem\s+k)\s+(?:výše\s+)?uveden))/i;
  const factMatch = text.match(factPattern);
  if (factMatch) {
    skutkovyStav = factMatch[1].trim();
  } else {
    const afterOduvodneni = text.replace(/^[\s\S]*?(?:odůvodnění|O\s*d\s*ů\s*v\s*o\s*d\s*n\s*ě\s*n\s*í)[:\s]*/i, "");
    const paragraphs = afterOduvodneni.split(/\n\s*\n/).filter((p) => p.trim().length > 50);
    skutkovyStav = paragraphs.slice(0, 3).join("\n\n").substring(0, 2000);
  }

  let pravniOtazka = "";
  const legalPattern = /(?:právní\s+(?:posouzení|hodnocení|otázk[au])|(?:po\s+)?právní\s+stránce|k\s+(?:právní(?:mu)?|hmotněprávní(?:mu)?)\s+(?:posouzení|hodnocení))[:\s]*([\s\S]{50,2000}?)(?=(?:soud\s+(?:proto\s+)?(?:dospěl|uzavřel|rozhodl)|závěrem|(?:s\s+)?ohledem\s+na\s+(?:výše\s+)?uveden|ze?\s+(?:všech\s+)?(?:výše\s+)?uveden[ýé]ch\s+důvodů|poučení))/i;
  const legalMatch = text.match(legalPattern);
  if (legalMatch) {
    pravniOtazka = legalMatch[1].trim();
  }

  let zaver = "";
  const conclusionPattern = /(?:(?:ze?\s+(?:všech\s+)?(?:výše\s+)?uveden[ýé]ch\s+důvodů|závěrem|soud\s+proto\s+(?:rozhodl|dospěl\s+k\s+závěru))[:\s]*([\s\S]{50,1500}?)(?=(?:poučení|p\s*o\s*u\s*č\s*e\s*n\s*í)|$))/i;
  const conclusionMatch = text.match(conclusionPattern);
  if (conclusionMatch) {
    zaver = conclusionMatch[1].trim();
  }

  return { skutkovyStav, pravniOtazka, zaver };
}

// --- Business logic (shared by MCP tools and web API) ---

interface CitedProvisionsResult {
  decision: { spisovaZnacka: string; ecli: string; nazevSoudu: string; datumVydani: string };
  metadataProvisions: string[];
  textProvisions: string[];
  allProvisions: string[];
}

async function analyzeCitedProvisions(documentId: string): Promise<CitedProvisionsResult> {
  const decision = await fetchDecision(documentId);
  if (!decision) throw new Error(`Rozhodnutí ${documentId} nenalezeno.`);

  const fullText = decision.vyrokAOduvodneni || "";
  const textProvisions = extractProvisions(fullText);
  const metadataProvisions = decision.dotcenaUstanoveni || [];
  const allProvisions = [...new Set([...metadataProvisions, ...textProvisions])];

  return {
    decision: {
      spisovaZnacka: decision.spisovaZnacka,
      ecli: decision.ecli,
      nazevSoudu: decision.nazevSoudu,
      datumVydani: decision.datumVydani,
    },
    metadataProvisions,
    textProvisions,
    allProvisions,
  };
}

interface RelatedDecisionsResult {
  decision: { spisovaZnacka: string; ecli: string; nazevSoudu: string; datumVydani: string };
  citations: string[];
  provisions: string[];
  caseType: string;
  caseTypeName: string;
  keywords: string[];
}

async function analyzeRelatedDecisions(documentId: string): Promise<RelatedDecisionsResult> {
  const decision = await fetchDecision(documentId);
  if (!decision) throw new Error(`Rozhodnutí ${documentId} nenalezeno.`);

  const fullText = decision.vyrokAOduvodneni || "";
  const citations = extractCitations(fullText);
  const metaProvisions = decision.dotcenaUstanoveni || [];
  const textProvisions = extractProvisions(fullText);
  const provisions = [...new Set([...metaProvisions, ...textProvisions])];
  const caseType = extractCaseType(decision.spisovaZnacka);
  const caseTypeName = CASE_TYPE_MAP[caseType] || caseType;
  const keywords = decision.klicovaSlova || [];

  return {
    decision: {
      spisovaZnacka: decision.spisovaZnacka,
      ecli: decision.ecli,
      nazevSoudu: decision.nazevSoudu,
      datumVydani: decision.datumVydani,
    },
    citations,
    provisions,
    caseType,
    caseTypeName,
    keywords,
  };
}

interface SummaryResult {
  decision: {
    spisovaZnacka: string;
    ecli: string;
    nazevSoudu: string;
    datumVydani: string;
    predmetRizeni: string;
  };
  caseType: string;
  caseTypeName: string;
  skutkovyStav: string;
  pravniOtazka: string;
  zaver: string;
  provisions: string[];
  citations: string[];
  keywords: string[];
}

async function summarizeDecision(documentId: string): Promise<SummaryResult> {
  const decision = await fetchDecision(documentId);
  if (!decision) throw new Error(`Rozhodnutí ${documentId} nenalezeno.`);

  const fullText = decision.vyrokAOduvodneni || "";
  const sections = splitDecisionSections(fullText);
  const metaProvisions = decision.dotcenaUstanoveni || [];
  const textProvisions = extractProvisions(fullText);
  const provisions = [...new Set([...metaProvisions, ...textProvisions])];
  const citations = extractCitations(fullText);
  const caseType = extractCaseType(decision.spisovaZnacka);
  const caseTypeName = CASE_TYPE_MAP[caseType] || caseType;
  const keywords = decision.klicovaSlova || [];

  return {
    decision: {
      spisovaZnacka: decision.spisovaZnacka,
      ecli: decision.ecli,
      nazevSoudu: decision.nazevSoudu,
      datumVydani: decision.datumVydani,
      predmetRizeni: decision.predmetRizeni || "",
    },
    caseType,
    caseTypeName,
    skutkovyStav: sections.skutkovyStav,
    pravniOtazka: sections.pravniOtazka,
    zaver: sections.zaver,
    provisions,
    citations,
    keywords,
  };
}

// --- MCP tools registration ---

function registerTools(srv: McpServer) {
  srv.tool(
    "get_cited_provisions",
    "Extract all legal provisions (§ references) cited in a court decision.",
    { documentId: z.string().describe("Document ID of the decision") },
    async ({ documentId }) => {
      try {
        const r = await analyzeCitedProvisions(documentId);
        const lines = [
          `Decision: ${r.decision.spisovaZnacka} (${r.decision.ecli})`,
          `Court: ${r.decision.nazevSoudu} | Date: ${r.decision.datumVydani}`,
          "",
          `=== From metadata (${r.metadataProvisions.length}) ===`,
          ...r.metadataProvisions.map((p) => `  • ${p}`),
          "",
          `=== From text (${r.textProvisions.length}) ===`,
          ...r.textProvisions.map((p) => `  • ${p}`),
          "",
          `Total unique: ${r.allProvisions.length}`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error}` }], isError: true };
      }
    }
  );

  srv.tool(
    "get_related_decisions",
    "Find related court decisions based on same provisions, case type, and citations.",
    { documentId: z.string().describe("Document ID of the decision") },
    async ({ documentId }) => {
      try {
        const r = await analyzeRelatedDecisions(documentId);
        const lines = [
          `Related for: ${r.decision.spisovaZnacka} (${r.decision.ecli})`,
          "",
          `=== Cited decisions (${r.citations.length}) ===`,
          ...(r.citations.length > 0 ? r.citations.map((c) => `  • ${c}`) : ["  (none)"]),
          "",
          `=== Shared provisions (${r.provisions.length}) ===`,
          ...r.provisions.slice(0, 15).map((p) => `  • ${p}`),
          ...(r.provisions.length > 15 ? [`  ... +${r.provisions.length - 15} more`] : []),
          "",
          `=== Case type: ${r.caseType || "?"} (${r.caseTypeName}) ===`,
          "",
          ...(r.keywords.length > 0
            ? [`=== Keywords ===`, ...r.keywords.map((k) => `  • ${k}`)]
            : []),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error}` }], isError: true };
      }
    }
  );

  srv.tool(
    "summarize_decision_for_judge",
    "Structured summary of a court decision for a judge.",
    { documentId: z.string().describe("Document ID of the decision") },
    async ({ documentId }) => {
      try {
        const r = await summarizeDecision(documentId);
        const na = "(Nepodařilo se automaticky extrahovat)";
        const lines = [
          `${r.decision.spisovaZnacka} | ${r.decision.ecli}`,
          `Soud: ${r.decision.nazevSoudu} | Datum: ${r.decision.datumVydani}`,
          `Předmět: ${r.decision.predmetRizeni || "N/A"} | Typ: ${r.caseType} (${r.caseTypeName})`,
          "",
          "1. SKUTKOVÝ STAV",
          r.skutkovyStav || na,
          "",
          "2. PRÁVNÍ OTÁZKA",
          r.pravniOtazka || na,
          "",
          "3. ZÁVĚR",
          r.zaver || na,
          "",
          `4. USTANOVENÍ (${r.provisions.length})`,
          ...r.provisions.map((p) => `  • ${p}`),
          "",
          `5. SOUVISEJÍCÍ JUDIKÁTY (${r.citations.length})`,
          ...(r.citations.length > 0 ? r.citations.map((c) => `  • ${c}`) : ["  (none)"]),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error}` }], isError: true };
      }
    }
  );
}

// --- Web API routes ---

function registerWebRoutes(app: express.Application) {
  // REST API
  app.get("/api/cited-provisions/:id", async (req: Request, res: Response) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await analyzeCitedProvisions(id);
      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(404).json({ error: msg });
    }
  });

  app.get("/api/related-decisions/:id", async (req: Request, res: Response) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await analyzeRelatedDecisions(id);
      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(404).json({ error: msg });
    }
  });

  app.get("/api/summary/:id", async (req: Request, res: Response) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await summarizeDecision(id);
      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(404).json({ error: msg });
    }
  });

  // Serve static frontend
  app.use(express.static(path.join(__dirname, "..", "public")));

  // SPA fallback
  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });
}

// --- Start ---

async function main() {
  // Auto-detect: if PORT is set (Railway/cloud) or MCP_TRANSPORT=http, use HTTP mode
  const mode = process.env.MCP_TRANSPORT || (process.env.PORT ? "http" : "stdio");

  if (mode === "http") {
    const app = express();
    app.use(express.json());

    app.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });

    // MCP endpoint
    app.all("/mcp", async (req, res) => {
      const httpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const httpServer = new McpServer({
        name: "mcp-server-databaze-rozhodnuti",
        version: "1.0.0",
      });
      registerTools(httpServer);
      await httpServer.connect(httpTransport);
      await httpTransport.handleRequest(req, res, req.body);
    });

    // Web app routes
    registerWebRoutes(app);

    const port = parseInt(process.env.PORT || "3000", 10);
    app.listen(port, "0.0.0.0", () => {
      console.error(`Server listening on http://0.0.0.0:${port}`);
      console.error(`  Web UI:  http://localhost:${port}`);
      console.error(`  MCP:     http://localhost:${port}/mcp`);
      console.error(`  API:     http://localhost:${port}/api/...`);
    });
  } else {
    const server = new McpServer({
      name: "mcp-server-databaze-rozhodnuti",
      version: "1.0.0",
    });
    registerTools(server);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MCP server started (stdio)");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
