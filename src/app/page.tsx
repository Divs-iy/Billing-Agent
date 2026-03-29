"use client";

import axios from "axios";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  FileUp,
  ImageIcon,
  Loader2,
  QrCode,
  RefreshCw,
  Sparkles,
  Upload,
  XCircle,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

/* —— Types —— */

type BillItem = {
  name: string;
  amount: number;
};

export type ExtractedBill = {
  items: BillItem[];
  subtotal: number | null;
  tax: number | null;
  total: number | null;
};

/** Sum of literal ₹ / Rs. amounts on non-summary lines (cash receipts). */
export type CashReceiptAnalysis = {
  itemSumStandalone: number;
  itemSumParsed: number;
  effectiveItemSum: number;
  itemSumSource: "standalone" | "parsed" | "both_differ";
  effectiveTaxRatePct: number | null;
  taxSuspicious: boolean;
  expectedTotal: number | null;
  totalVsExpected: "ok" | "warn" | "error" | null;
  totalDiff: number | null;
  standaloneDiffersFromParsed: boolean;
};

type GstQrData = {
  SellerGstin?: string;
  BuyerGstin?: string;
  DocNo?: string;
  DocDt?: string;
  TotInvVal?: number;
  ItemCnt?: number;
  ItemList?: Array<Record<string, unknown>>;
  raw: Record<string, unknown>;
};

export type VerificationIssue = {
  id: string;
  severity: "ok" | "warn" | "error";
  message: string;
};

type Toast = {
  id: string;
  type: "error" | "success";
  message: string;
};

/* —— GST QR parsing —— */

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function normalizeGstPayload(j: Record<string, unknown>): GstQrData {
  const keys = Object.keys(j);
  const findVal = (candidates: string[]): unknown => {
    for (const k of keys) {
      const lower = k.toLowerCase();
      if (candidates.some((c) => lower === c.toLowerCase())) return j[k];
    }
    for (const c of candidates) {
      if (c in j) return j[c];
    }
    return undefined;
  };

  const valDtlsRaw = findVal(["ValDtls", "valDtls"]);
  let valDtlsTot: number | undefined;
  if (valDtlsRaw && typeof valDtlsRaw === "object") {
    const vd = valDtlsRaw as Record<string, unknown>;
    valDtlsTot =
      toNumber(vd.TotInvVal) ??
      toNumber(vd.totInvVal) ??
      toNumber(vd.TotInv);
  }

  const tot =
    toNumber(findVal(["TotInvVal", "totInvVal", "Total", "totinvval"])) ??
    valDtlsTot;

  const itemListRaw = findVal(["ItemList", "itemList"]);
  const itemList = Array.isArray(itemListRaw)
    ? (itemListRaw as Array<Record<string, unknown>>)
    : undefined;

  const sg = findVal(["SellerGstin", "sellerGstin"]);
  const bg = findVal(["BuyerGstin", "buyerGstin"]);
  const docNo = findVal(["DocNo", "docNo", "docno"]);
  const docDt = findVal(["DocDt", "docDt", "docdt"]);

  return {
    SellerGstin: sg != null ? String(sg) : undefined,
    BuyerGstin: bg != null ? String(bg) : undefined,
    DocNo: docNo != null ? String(docNo) : undefined,
    DocDt: docDt != null ? String(docDt) : undefined,
    TotInvVal: tot,
    ItemCnt: toNumber(findVal(["ItemCnt", "itemCnt"])),
    ItemList: itemList,
    raw: j,
  };
}

export function parseGstQrPayload(raw: string): GstQrData | null {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") return normalizeGstPayload(parsed);
  } catch {
    /* fall through */
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<
        string,
        unknown
      >;
      if (parsed && typeof parsed === "object") return normalizeGstPayload(parsed);
    } catch {
      return null;
    }
  }
  return null;
}

function sumQrItemAmounts(data: GstQrData): number | null {
  if (!data.ItemList?.length) return null;
  let sum = 0;
  let any = false;
  for (const row of data.ItemList) {
    const amt =
      toNumber(row.TotAmt) ??
      toNumber(row.totAmt) ??
      toNumber(row["TotAmt"]) ??
      toNumber(row["totamt"]);
    if (amt != null) {
      sum += amt;
      any = true;
    }
  }
  return any ? sum : null;
}

/* —— OCR extraction (regex heuristics) —— */

function parseMoneyToken(s: string): number | null {
  const cleaned = s.replace(/[,\s₹]/g, "").replace(/^Rs\.?/i, "");
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

function extractBillFromText(text: string): ExtractedBill {
  const normalized = text.replace(/\r/g, "\n");
  const lines = normalized.split("\n").map((l) => l.trim());

  let subtotal: number | null = null;
  const subPatterns = [
    /(?:sub[-\s]?total|taxable\s*(?:value|amount)|amount\s*before\s*tax|taxable\s*val)[^\d₹-]*[₹]?\s*([\d,]+(?:\.\d+)?)/i,
    /(?:^|\s)(?:subtotal|sub\s*total)\s*[:\-]?\s*[₹]?\s*([\d,]+(?:\.\d+)?)/i,
  ];
  for (const re of subPatterns) {
    const m = normalized.match(re);
    if (m?.[1]) {
      subtotal = parseMoneyToken(m[1]);
      if (subtotal != null) break;
    }
  }

  let tax: number | null = null;
  const taxLineRe =
    /(?:CGST|SGST|IGST|GST|VAT|CESS)[^\d₹-]*[₹]?\s*([\d,]+(?:\.\d+)?)/gi;
  let taxSum = 0;
  let taxHits = 0;
  let tm: RegExpExecArray | null = taxLineRe.exec(normalized);
  while (tm) {
    const v = parseMoneyToken(tm[1]);
    if (v != null) {
      taxSum += v;
      taxHits += 1;
    }
    tm = taxLineRe.exec(normalized);
  }
  if (taxHits > 0) tax = Math.round(taxSum * 100) / 100;

  let total: number | null = null;
  const totalPatterns = [
    /(?:grand\s*total|net\s*(?:amount|payable|due)|total\s*(?:due|payable|amount)?|amount\s*payable|balance\s*due)[^\d₹-]*[₹]?\s*([\d,]+(?:\.\d+)?)/i,
    /(?:^|\n)\s*total\s*[:\-]?\s*[₹]?\s*([\d,]+(?:\.\d+)?)/im,
  ];
  for (const re of totalPatterns) {
    const m = normalized.match(re);
    if (m?.[1]) {
      total = parseMoneyToken(m[1]);
      if (total != null) break;
    }
  }

  if (total == null) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      if (/total/i.test(line) && !/sub/i.test(line)) {
        const nums = [...line.matchAll(/([\d,]+(?:\.\d+)?)/g)]
          .map((x) => parseMoneyToken(x[1]))
          .filter((n): n is number => n != null);
        if (nums.length) {
          total = nums[nums.length - 1];
          break;
        }
      }
    }
  }

  const items: BillItem[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.length < 3) continue;
    if (
      /^(total|sub|gst|cgst|sgst|igst|invoice|date|bill|tax|thank|page)/i.test(
        line,
      )
    )
      continue;
    const nums = [...line.matchAll(/([\d,]+(?:\.\d+)?)/g)]
      .map((x) => parseMoneyToken(x[1]))
      .filter((n): n is number => n != null && n > 0 && n < 1e10);
    if (nums.length >= 2) {
      const amount = nums[nums.length - 1];
      let name = line
        .replace(/[\d,.\s₹]+$/g, "")
        .replace(/^\d+[.)]\s*/, "")
        .trim();
      name = name.replace(/\s{2,}/g, " ").slice(0, 120);
      if (name.length < 2) continue;
      const key = `${name}:${amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ name, amount });
    }
  }

  return {
    items: items.slice(0, 40),
    subtotal,
    tax,
    total,
  };
}

/** Sum standalone ₹XX.XX / Rs. prices on lines that are not totals/tax headers. */
function sumStandaloneRupeePrices(text: string): number {
  const lines = text.split(/\r?\n/);
  let sum = 0;

  const skipLine = (line: string): boolean => {
    const t = line.trim();
    if (t.length < 2) return true;
    return /(?:grand\s*total|total\s*due|sub\s*[-–]?\s*total|amount\s*payable|balance\s*due|net\s*payable|amount\s*to\s*pay|^\s*total\s*[:\-]|^total\s*$|cgst|sgst|igst|^\s*gst\s|^\s*tax\s|vat\s*\(|net\s*amt|change\s*due)/i.test(
      t,
    );
  };

  for (const line of lines) {
    if (skipLine(line)) continue;
    const rupeeRe = /(?:₹|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)/gi;
    let m: RegExpExecArray | null;
    while ((m = rupeeRe.exec(line)) !== null) {
      const v = parseMoneyToken(m[1]);
      if (v != null && v > 0 && v < 1e9) sum += v;
    }
  }
  return Math.round(sum * 100) / 100;
}

const CASH_RECEIPT_TOL = 1;

export function analyzeCashReceipt(
  ocrText: string,
  extracted: ExtractedBill,
): CashReceiptAnalysis {
  const itemSumStandalone = sumStandaloneRupeePrices(ocrText);
  const itemSumParsed = extracted.items.reduce((s, i) => s + i.amount, 0);
  const hasStandalone = itemSumStandalone > 0;
  const hasParsed = itemSumParsed > 0;
  const standaloneDiffersFromParsed =
    hasStandalone &&
    hasParsed &&
    Math.abs(itemSumStandalone - itemSumParsed) > CASH_RECEIPT_TOL;

  let effectiveItemSum: number;
  let itemSumSource: CashReceiptAnalysis["itemSumSource"];
  if (hasStandalone) {
    effectiveItemSum = itemSumStandalone;
    itemSumSource = standaloneDiffersFromParsed ? "both_differ" : "standalone";
  } else if (hasParsed) {
    effectiveItemSum = itemSumParsed;
    itemSumSource = "parsed";
  } else {
    effectiveItemSum = 0;
    itemSumSource = "parsed";
  }

  const tax = extracted.tax;
  const total = extracted.total;

  let effectiveTaxRatePct: number | null = null;
  if (tax != null && effectiveItemSum > 0) {
    effectiveTaxRatePct = Math.round((tax / effectiveItemSum) * 1000) / 10;
  }

  const taxSuspicious =
    effectiveTaxRatePct != null && effectiveTaxRatePct > 20;

  let expectedTotal: number | null = null;
  if (effectiveItemSum > 0) {
    expectedTotal = effectiveItemSum + (tax ?? 0);
  }

  let totalVsExpected: CashReceiptAnalysis["totalVsExpected"] = null;
  let totalDiff: number | null = null;
  if (total != null && expectedTotal != null) {
    totalDiff = Math.abs(total - expectedTotal);
    if (totalDiff <= CASH_RECEIPT_TOL) totalVsExpected = "ok";
    else if (totalDiff <= 3) totalVsExpected = "warn";
    else totalVsExpected = "error";
  }

  return {
    itemSumStandalone,
    itemSumParsed,
    effectiveItemSum,
    itemSumSource,
    effectiveTaxRatePct,
    taxSuspicious,
    expectedTotal,
    totalVsExpected,
    totalDiff,
    standaloneDiffersFromParsed,
  };
}

/* —— Verification —— */

const TOL_ABS = 1;
const TOL_PCT = 0.015;

function near(a: number, b: number): boolean {
  const d = Math.abs(a - b);
  return d <= Math.max(TOL_ABS, TOL_PCT * Math.max(Math.abs(a), Math.abs(b)));
}

function buildVerificationIssues(
  qr: GstQrData | null,
  extracted: ExtractedBill,
  ocrText: string,
): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  let id = 0;
  const add = (
    severity: VerificationIssue["severity"],
    message: string,
  ): void => {
    issues.push({ id: `v-${id++}`, severity, message });
  };

  if (qr?.TotInvVal != null && extracted.total != null) {
    if (near(qr.TotInvVal, extracted.total)) {
      add(
        "ok",
        `QR invoice total (${qr.TotInvVal.toFixed(2)}) matches OCR total (${extracted.total.toFixed(2)}).`,
      );
    } else {
      add(
        "error",
        `QR total (${qr.TotInvVal.toFixed(2)}) vs OCR total (${extracted.total.toFixed(2)}) — difference ${Math.abs(qr.TotInvVal - extracted.total).toFixed(2)}.`,
      );
    }
  } else if (qr?.TotInvVal != null && extracted.total == null) {
    add("warn", "QR contains total but OCR did not detect a clear total line.");
  } else if (!qr?.TotInvVal && extracted.total != null) {
    add("warn", "No QR total to compare; scan the GST QR for cross-check.");
  }

  const sumItems = extracted.items.reduce((s, i) => s + i.amount, 0);
  if (extracted.items.length > 0 && extracted.subtotal != null) {
    if (near(sumItems, extracted.subtotal)) {
      add(
        "ok",
        `Sum of parsed line items (${sumItems.toFixed(2)}) matches subtotal (${extracted.subtotal.toFixed(2)}).`,
      );
    } else {
      add(
        "warn",
        `Line items sum (${sumItems.toFixed(2)}) vs subtotal (${extracted.subtotal.toFixed(2)}) — verify table layout.`,
      );
    }
  }

  if (
    extracted.subtotal != null &&
    extracted.tax != null &&
    extracted.total != null
  ) {
    const calc = extracted.subtotal + extracted.tax;
    if (near(calc, extracted.total)) {
      add(
        "ok",
        `Subtotal + tax (${calc.toFixed(2)}) matches total (${extracted.total.toFixed(2)}).`,
      );
    } else {
      add(
        "error",
        `Math check: subtotal (${extracted.subtotal.toFixed(2)}) + tax (${extracted.tax.toFixed(2)}) = ${calc.toFixed(2)}, but OCR total is ${extracted.total.toFixed(2)}.`,
      );
    }
  }

  if (qr?.TotInvVal != null) {
    const qrItems = sumQrItemAmounts(qr);
    if (qrItems != null && near(qrItems, qr.TotInvVal)) {
      add("ok", "QR item list sums to the QR invoice total.");
    } else if (qrItems != null && !near(qrItems, qr.TotInvVal)) {
      add(
        "error",
        `QR item amounts sum to ${qrItems.toFixed(2)} but QR total is ${qr.TotInvVal.toFixed(2)}.`,
      );
    }
  }

  const cash = analyzeCashReceipt(ocrText, extracted);
  if (cash.effectiveItemSum > 0) {
    add(
      "ok",
      `Item total (standalone ₹ sum): ${cash.effectiveItemSum.toFixed(2)}${
        cash.itemSumSource === "parsed"
          ? " — from parsed lines (no ₹ literals found)"
          : ""
      }`,
    );
    if (cash.standaloneDiffersFromParsed) {
      add(
        "warn",
        `Standalone ₹ sum (${cash.itemSumStandalone.toFixed(2)}) differs from parsed line sum (${cash.itemSumParsed.toFixed(2)}).`,
      );
    }
    if (cash.taxSuspicious && extracted.tax != null) {
      add(
        "warn",
        `Suspicious rate: tax is ${cash.effectiveTaxRatePct?.toFixed(1)}% of item total (> 20%).`,
      );
    }
    if (cash.expectedTotal != null && extracted.total != null) {
      if (cash.totalVsExpected === "ok") {
        add(
          "ok",
          `Total (${extracted.total.toFixed(2)}) = item total + tax (${cash.expectedTotal.toFixed(2)}) within ₹${CASH_RECEIPT_TOL}.`,
        );
      } else if (cash.totalVsExpected === "warn") {
        add(
          "warn",
          `Total (${extracted.total.toFixed(2)}) vs item total + tax (${cash.expectedTotal.toFixed(2)}) — off by ₹${cash.totalDiff?.toFixed(2)}.`,
        );
      } else if (cash.totalVsExpected === "error") {
        add(
          "error",
          `Total (${extracted.total.toFixed(2)}) ≠ item total + tax (${cash.expectedTotal.toFixed(2)}) — difference ₹${cash.totalDiff?.toFixed(2)}.`,
        );
      }
    }
  }

  if (issues.length === 0) {
    add("warn", "Run OCR and scan QR to populate verification checks.");
  }

  return issues;
}

function severityCellClass(s: "ok" | "warn" | "error" | null | undefined): string {
  if (s === "ok") return "bg-emerald-500/15 text-emerald-200 border-emerald-500/30";
  if (s === "warn") return "bg-amber-500/15 text-amber-200 border-amber-500/30";
  if (s === "error") return "bg-red-500/15 text-red-200 border-red-500/35";
  return "bg-white/5 text-slate-400 border-white/10";
}

/* —— UI primitives (shadcn-style, no extra deps) —— */

function cn(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-white/10 bg-white/5 shadow-sm backdrop-blur-md",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Button({
  className,
  children,
  disabled,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}

/* —— Page —— */

export default function BillingAgentPage() {
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const qrInstanceRef = useRef<{ stop: () => Promise<void> } | null>(null);

  const [heroMode, setHeroMode] = useState<"camera" | "upload" | "qr" | null>(
    null,
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [qrData, setQrData] = useState<GstQrData | null>(null);
  const [qrRaw, setQrRaw] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string>("");
  const [extracted, setExtracted] = useState<ExtractedBill | null>(null);
  const [issues, setIssues] = useState<VerificationIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const qrRegionId = useId().replace(/:/g, "");
  const qrContainerId = `qr-${qrRegionId}`;

  const cashReceipt = useMemo(() => {
    if (!extracted || !ocrText) return null;
    return analyzeCashReceipt(ocrText, extracted);
  }, [extracted, ocrText]);

  const pushToast = useCallback((type: Toast["type"], message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((t) => [...t, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 5000);
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    if (previewVideoRef.current) previewVideoRef.current.srcObject = null;
  }, []);

  const startPreview = useCallback(async () => {
    stopCamera();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      if (previewVideoRef.current) {
        previewVideoRef.current.srcObject = stream;
        await previewVideoRef.current.play();
      }
    } catch (e) {
      pushToast(
        "error",
        e instanceof Error ? e.message : "Could not access camera.",
      );
    }
  }, [pushToast, stopCamera]);

  useEffect(() => {
    if (heroMode === "camera") void startPreview();
    else stopCamera();
    return () => {
      stopCamera();
    };
  }, [heroMode, startPreview, stopCamera]);

  const captureFrame = useCallback(() => {
    const video = previewVideoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || !video.videoWidth) {
      pushToast("error", "Camera not ready.");
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      pushToast("error", "Could not capture frame.");
      return;
    }
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          pushToast("error", "Capture failed.");
          return;
        }
        const url = URL.createObjectURL(blob);
        setPreviewUrl((prev) => {
          if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
          return url;
        });
        setOcrText("");
        setExtracted(null);
        setIssues([]);
        pushToast("success", "Bill image captured. Tap Analyze Bill.");
      },
      "image/jpeg",
      0.92,
    );
  }, [pushToast]);

  const onFile = useCallback(
    (file: File | undefined) => {
      if (!file || !file.type.startsWith("image/")) {
        pushToast("error", "Please choose an image file.");
        return;
      }
      const url = URL.createObjectURL(file);
      setPreviewUrl((prev) => {
        if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
        return url;
      });
      setOcrText("");
      setExtracted(null);
      setIssues([]);
      pushToast("success", "Image loaded.");
    },
    [pushToast],
  );

  const stopQrScanner = useCallback(async () => {
    const h = qrInstanceRef.current;
    qrInstanceRef.current = null;
    if (h) {
      try {
        await h.stop();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const startQrScanner = useCallback(async () => {
    await stopQrScanner();
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const el = document.getElementById(qrContainerId);
      if (!el) {
        pushToast("error", "Scanner container not found.");
        return;
      }
      const qr = new Html5Qrcode(qrContainerId);
      qrInstanceRef.current = qr;
      await qr.start(
        { facingMode: "environment" },
        { fps: 8, qrbox: { width: 240, height: 240 } },
        (decodedText) => {
          setQrRaw(decodedText);
          const parsed = parseGstQrPayload(decodedText);
          if (parsed) {
            setQrData(parsed);
            pushToast("success", "GST QR parsed.");
            void qr.pause(true);
          } else {
            pushToast("error", "Decoded text is not valid GST JSON.");
          }
        },
        () => {
          /* frame — ignore */
        },
      );
    } catch (e) {
      pushToast(
        "error",
        e instanceof Error ? e.message : "Could not start QR scanner.",
      );
    }
  }, [pushToast, qrContainerId, stopQrScanner]);

  useEffect(() => {
    if (heroMode === "qr") void startQrScanner();
    else void stopQrScanner();
    return () => {
      void stopQrScanner();
    };
  }, [heroMode, startQrScanner, stopQrScanner]);

  const loadRemoteImage = useCallback(async () => {
    const url = remoteUrl.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      pushToast("error", "Enter a valid http(s) image URL.");
      return;
    }
    setLoading(true);
    setLoadingMessage("Downloading image…");
    try {
      const { data } = await axios.get<Blob>(url, {
        responseType: "blob",
        timeout: 20000,
        validateStatus: (s) => s >= 200 && s < 300,
      });
      if (!data.type.startsWith("image/")) {
        pushToast("error", "URL did not return an image.");
        return;
      }
      const blobUrl = URL.createObjectURL(data);
      setPreviewUrl((prev) => {
        if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
        return blobUrl;
      });
      setOcrText("");
      setExtracted(null);
      setIssues([]);
      pushToast("success", "Image loaded from URL.");
    } catch (e) {
      pushToast(
        "error",
        axios.isAxiosError(e)
          ? e.message
          : e instanceof Error
            ? e.message
            : "Download failed.",
      );
    } finally {
      setLoading(false);
      setLoadingMessage("");
    }
  }, [pushToast, remoteUrl]);

  const runAnalyze = useCallback(async () => {
    if (!previewUrl) {
      pushToast("error", "Add a bill image first.");
      return;
    }
    setLoading(true);
    setLoadingMessage("Running OCR (English + Hindi)…");
    setOcrText("");
    setExtracted(null);
    setIssues([]);
    try {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng+hin", 1, {
        logger: (m) => {
          if (m.status === "recognizing text") {
            setLoadingMessage(
              `OCR… ${Math.round((m.progress ?? 0) * 100)}%`,
            );
          }
        },
      });
      const {
        data: { text },
      } = await worker.recognize(previewUrl);
      await worker.terminate();
      setOcrText(text);
      const ex = extractBillFromText(text);
      setExtracted(ex);
      setIssues(buildVerificationIssues(qrData, ex, text));
      pushToast("success", "Analysis complete.");
    } catch (e) {
      pushToast(
        "error",
        e instanceof Error ? e.message : "OCR failed.",
      );
    } finally {
      setLoading(false);
      setLoadingMessage("");
    }
  }, [previewUrl, pushToast, qrData]);

  return (
    <div className="relative min-h-full bg-gradient-to-br from-violet-950 via-indigo-950 to-blue-950 text-slate-100">
      {loading && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/10 bg-slate-900/90 px-8 py-6 shadow-xl">
            <Loader2 className="h-10 w-10 animate-spin text-indigo-300" />
            <p className="max-w-xs text-center text-sm text-slate-300">
              {loadingMessage || "Working…"}
            </p>
          </div>
        </div>
      )}

      <div className="pointer-events-none fixed right-4 top-4 z-[60] flex w-full max-w-sm flex-col gap-2 sm:right-6 sm:top-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur-md",
              t.type === "error"
                ? "border-red-400/40 bg-red-950/90 text-red-100"
                : "border-emerald-400/40 bg-emerald-950/90 text-emerald-100",
            )}
          >
            {t.message}
          </div>
        ))}
      </div>

      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 lg:py-12">
        <header className="text-center sm:text-left">
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-indigo-200">
            <Sparkles className="h-3.5 w-3.5" />
            Client-side OCR · GST QR
          </div>
          <h1 className="bg-gradient-to-r from-violet-200 via-indigo-200 to-blue-200 bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-4xl">
            AI Billing Agent
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400 sm:text-base">
            Capture or upload a bill, scan the GST QR, then analyze with
            Tesseract. We extract line items and totals and flag math or QR
            mismatches.
          </p>
        </header>

        <Card className="p-4 sm:p-6">
          <p className="mb-4 text-xs font-medium uppercase tracking-wide text-indigo-300/90">
            Hero — choose input
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button
              className={cn(
                "border border-white/10 bg-white/10 hover:bg-white/15",
                heroMode === "camera" && "ring-2 ring-indigo-400",
              )}
              onClick={() =>
                setHeroMode((m) => (m === "camera" ? null : "camera"))
              }
            >
              <Camera className="h-4 w-4" />
              Camera
            </Button>
            <Button
              className={cn(
                "border border-white/10 bg-white/10 hover:bg-white/15",
                heroMode === "upload" && "ring-2 ring-indigo-400",
              )}
              onClick={() =>
                setHeroMode((m) => (m === "upload" ? null : "upload"))
              }
            >
              <Upload className="h-4 w-4" />
              Upload
            </Button>
            <Button
              className={cn(
                "border border-white/10 bg-white/10 hover:bg-white/15",
                heroMode === "qr" && "ring-2 ring-indigo-400",
              )}
              onClick={() => setHeroMode((m) => (m === "qr" ? null : "qr"))}
            >
              <QrCode className="h-4 w-4" />
              Scan QR
            </Button>
          </div>

          {heroMode === "camera" && (
            <div className="mt-6 space-y-4">
              <div className="overflow-hidden rounded-lg border border-white/10 bg-black/40">
                <video
                  ref={previewVideoRef}
                  className="aspect-video w-full object-cover"
                  playsInline
                  muted
                />
              </div>
              <canvas ref={captureCanvasRef} className="hidden" />
              <div className="flex flex-wrap gap-2">
                <Button
                  className="bg-indigo-600 text-white hover:bg-indigo-500"
                  onClick={captureFrame}
                >
                  <Camera className="h-4 w-4" />
                  Capture Bill
                </Button>
                <Button
                  className="border border-white/20 bg-transparent hover:bg-white/10"
                  onClick={() => void startPreview()}
                >
                  <RefreshCw className="h-4 w-4" />
                  Restart camera
                </Button>
              </div>
            </div>
          )}

          {heroMode === "upload" && (
            <div className="mt-6 space-y-4">
              <label
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-center transition",
                  dragOver
                    ? "border-indigo-400 bg-indigo-500/10"
                    : "border-white/20 bg-white/5 hover:border-white/30",
                )}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  onFile(e.dataTransfer.files[0]);
                }}
              >
                <FileUp className="h-10 w-10 text-indigo-300" />
                <span className="text-sm font-medium">
                  Drag & drop an image here
                </span>
                <span className="text-xs text-slate-400">or click to browse</span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => onFile(e.target.files?.[0])}
                />
              </label>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <label className="mb-1 block text-xs text-slate-400">
                    Import from URL (axios)
                  </label>
                  <input
                    type="url"
                    value={remoteUrl}
                    onChange={(e) => setRemoteUrl(e.target.value)}
                    placeholder="https://…/bill.jpg"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none ring-indigo-500/50 placeholder:text-slate-500 focus:ring-2"
                  />
                </div>
                <Button
                  className="shrink-0 bg-blue-600 text-white hover:bg-blue-500"
                  onClick={() => void loadRemoteImage()}
                  disabled={loading}
                >
                  Load URL
                </Button>
              </div>
            </div>
          )}

          {heroMode === "qr" && (
            <div className="mt-6 space-y-3">
              <p className="text-xs text-slate-400">
                Point the camera at the GST QR on the invoice. Parsed JSON is
                stored for comparison with OCR totals.
              </p>
              <div
                id={qrContainerId}
                className="overflow-hidden rounded-lg border border-white/10 bg-black/50"
              />
              {qrRaw && (
                <details className="rounded-lg border border-white/10 bg-black/30 p-3 text-xs">
                  <summary className="cursor-pointer text-indigo-200">
                    Raw decode
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-slate-400">
                    {qrRaw.slice(0, 4000)}
                  </pre>
                </details>
              )}
              <Button
                className="border border-white/20 bg-transparent hover:bg-white/10"
                onClick={() => void startQrScanner()}
              >
                <RefreshCw className="h-4 w-4" />
                Restart scanner
              </Button>
            </div>
          )}
        </Card>

        <Card className="p-4 sm:p-6">
          <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-indigo-300/90">
                Bill preview
              </p>
              <p className="text-sm text-slate-400">
                Image used for OCR (camera, upload, or URL).
              </p>
            </div>
            <Button
              className="bg-gradient-to-r from-violet-600 to-blue-600 text-white shadow-lg hover:from-violet-500 hover:to-blue-500"
              onClick={() => void runAnalyze()}
              disabled={loading || !previewUrl}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Analyze Bill
            </Button>
          </div>
          <div className="flex min-h-[160px] items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-slate-950/50">
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt="Bill preview"
                className="max-h-80 w-full object-contain"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 py-12 text-slate-500">
                <ImageIcon className="h-12 w-12 opacity-40" />
                <span className="text-sm">No image yet</span>
              </div>
            )}
          </div>
        </Card>

        {(extracted || ocrText) && (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="p-4 sm:p-6">
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-indigo-300/90">
                Extracted items
              </p>
              <div className="overflow-x-auto rounded-lg border border-white/10">
                <table className="w-full min-w-[320px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/5 text-xs uppercase text-slate-400">
                      <th className="px-3 py-2 font-medium">Item</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                      <th className="w-[140px] px-3 py-2 text-center font-medium">
                        Check
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {extracted?.items?.length ? (
                      extracted.items.map((row, i) => (
                        <tr
                          key={`${row.name}-${i}`}
                          className="border-b border-white/5 last:border-0"
                        >
                          <td className="max-w-[200px] truncate px-3 py-2 text-slate-200">
                            {row.name}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-200">
                            {row.amount.toFixed(2)}
                          </td>
                          <td className="px-3 py-2 text-center text-slate-600">
                            —
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td
                          colSpan={3}
                          className="px-3 py-6 text-center text-slate-500"
                        >
                          No line items detected — check OCR text panel.
                        </td>
                      </tr>
                    )}
                  </tbody>
                  {cashReceipt && extracted && (
                    <tfoot>
                      <tr className="border-t-2 border-indigo-500/40 bg-indigo-950/30">
                        <td
                          colSpan={3}
                          className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-indigo-200"
                        >
                          Cash receipt — math & totals
                        </td>
                      </tr>
                      <tr className="border-b border-white/10 bg-white/[0.02]">
                        <td className="px-3 py-2.5 text-slate-200">
                          Item total (standalone ₹)
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-100">
                          {cashReceipt.itemSumStandalone > 0
                            ? cashReceipt.itemSumStandalone.toFixed(2)
                            : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span
                            className={cn(
                              "inline-block rounded-md border px-2 py-0.5 text-xs font-medium",
                              severityCellClass(
                                cashReceipt.itemSumStandalone > 0
                                  ? "ok"
                                  : undefined,
                              ),
                            )}
                          >
                            {cashReceipt.itemSumStandalone > 0
                              ? "Sum OK"
                              : "No ₹"}
                          </span>
                        </td>
                      </tr>
                      <tr className="border-b border-white/10 bg-white/[0.02]">
                        <td className="px-3 py-2.5 text-slate-200">
                          Parsed lines sum
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-100">
                          {cashReceipt.itemSumParsed.toFixed(2)}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span
                            className={cn(
                              "inline-block rounded-md border px-2 py-0.5 text-xs font-medium",
                              severityCellClass(
                                cashReceipt.standaloneDiffersFromParsed
                                  ? "warn"
                                  : "ok",
                              ),
                            )}
                          >
                            {cashReceipt.standaloneDiffersFromParsed
                              ? "Mismatch"
                              : "Match"}
                          </span>
                        </td>
                      </tr>
                      <tr className="border-b border-white/10 bg-white/[0.02]">
                        <td className="px-3 py-2.5 font-medium text-slate-100">
                          Effective item total
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-base tabular-nums text-indigo-100">
                          {cashReceipt.effectiveItemSum.toFixed(2)}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span
                            className={cn(
                              "inline-block rounded-md border px-2 py-0.5 text-xs font-medium",
                              severityCellClass(
                                cashReceipt.itemSumSource === "both_differ"
                                  ? "warn"
                                  : cashReceipt.effectiveItemSum > 0
                                    ? "ok"
                                    : undefined,
                              ),
                            )}
                          >
                            {cashReceipt.itemSumSource === "parsed"
                              ? "Parsed"
                              : cashReceipt.itemSumSource === "both_differ"
                                ? "Verify"
                                : "₹ sum"}
                          </span>
                        </td>
                      </tr>
                      <tr className="border-b border-white/10 bg-white/[0.02]">
                        <td className="px-3 py-2.5 text-slate-200">
                          Tax
                          {cashReceipt.effectiveTaxRatePct != null && (
                            <span className="block text-[10px] font-normal text-slate-500">
                              ({cashReceipt.effectiveTaxRatePct.toFixed(1)}% of
                              items)
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-100">
                          {extracted.tax != null
                            ? extracted.tax.toFixed(2)
                            : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span
                            className={cn(
                              "inline-block rounded-md border px-2 py-0.5 text-xs font-medium",
                              severityCellClass(
                                cashReceipt.taxSuspicious
                                  ? "warn"
                                  : extracted.tax != null
                                    ? "ok"
                                    : undefined,
                              ),
                            )}
                          >
                            {cashReceipt.taxSuspicious
                              ? "Suspicious rate"
                              : extracted.tax != null
                                ? "OK"
                                : "—"}
                          </span>
                        </td>
                      </tr>
                      <tr className="border-b border-white/10 bg-white/[0.02]">
                        <td className="px-3 py-2.5 text-slate-200">
                          Expected (items + tax)
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-100">
                          {cashReceipt.expectedTotal != null
                            ? cashReceipt.expectedTotal.toFixed(2)
                            : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-center text-xs text-slate-500">
                          ±₹{CASH_RECEIPT_TOL}
                        </td>
                      </tr>
                      <tr className="border-b border-white/10 bg-white/[0.02]">
                        <td className="px-3 py-2.5 text-slate-200">
                          OCR total
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-100">
                          {extracted.total != null
                            ? extracted.total.toFixed(2)
                            : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-center text-xs text-slate-500">
                          —
                        </td>
                      </tr>
                      <tr className="border-b border-white/10 bg-indigo-950/40">
                        <td className="px-3 py-2.5 font-medium text-slate-100">
                          Receipt math
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-sm tabular-nums text-slate-100">
                          {cashReceipt.totalVsExpected != null &&
                          cashReceipt.totalDiff != null
                            ? cashReceipt.totalVsExpected === "ok"
                              ? `Match (≤₹${CASH_RECEIPT_TOL})`
                              : `Off by ₹${cashReceipt.totalDiff.toFixed(2)}`
                            : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span
                            className={cn(
                              "inline-block rounded-md border px-2 py-0.5 text-xs font-semibold",
                              severityCellClass(
                                cashReceipt.totalVsExpected ?? undefined,
                              ),
                            )}
                          >
                            {cashReceipt.totalVsExpected === "ok"
                              ? "Perfect"
                              : cashReceipt.totalVsExpected === "warn"
                                ? "Warning"
                                : cashReceipt.totalVsExpected === "error"
                                  ? "Error"
                                  : "—"}
                          </span>
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              {extracted && (
                <dl className="mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                  <div className="rounded-lg bg-white/5 px-3 py-2">
                    <dt className="text-xs text-slate-500">
                      Subtotal{" "}
                      <span className="text-slate-600">(header)</span>
                    </dt>
                    <dd className="font-mono text-lg tabular-nums">
                      {extracted.subtotal != null
                        ? extracted.subtotal.toFixed(2)
                        : "—"}
                    </dd>
                    {cashReceipt && (
                      <dd className="mt-1 text-[11px] text-slate-500">
                        Item sum (cash):{" "}
                        <span className="font-mono text-slate-300">
                          {cashReceipt.effectiveItemSum.toFixed(2)}
                        </span>
                      </dd>
                    )}
                  </div>
                  <div className="rounded-lg bg-white/5 px-3 py-2">
                    <dt className="text-xs text-slate-500">Tax (sum)</dt>
                    <dd className="font-mono text-lg tabular-nums">
                      {extracted.tax != null ? extracted.tax.toFixed(2) : "—"}
                    </dd>
                  </div>
                  <div className="rounded-lg bg-white/5 px-3 py-2">
                    <dt className="text-xs text-slate-500">Total</dt>
                    <dd className="font-mono text-lg tabular-nums text-indigo-200">
                      {extracted.total != null
                        ? extracted.total.toFixed(2)
                        : "—"}
                    </dd>
                  </div>
                </dl>
              )}
            </Card>

            <Card className="flex flex-col p-4 sm:p-6">
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-indigo-300/90">
                Full OCR text
              </p>
              <pre className="max-h-64 flex-1 overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-slate-300 sm:max-h-96 sm:text-xs">
                {ocrText || "—"}
              </pre>
            </Card>
          </div>
        )}

        {issues.length > 0 && (
          <Card className="p-4 sm:p-6">
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-indigo-300/90">
              Verification & issues
            </p>
            <ul className="space-y-2">
              {issues.map((issue) => (
                <li
                  key={issue.id}
                  className={cn(
                    "flex gap-3 rounded-lg border px-3 py-2.5 text-sm",
                    issue.severity === "ok" &&
                      "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
                    issue.severity === "warn" &&
                      "border-amber-500/30 bg-amber-500/10 text-amber-100",
                    issue.severity === "error" &&
                      "border-red-500/40 bg-red-500/10 text-red-100",
                  )}
                >
                  {issue.severity === "ok" && (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  )}
                  {issue.severity === "warn" && (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  )}
                  {issue.severity === "error" && (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                  )}
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
            {qrData?.TotInvVal != null && (
              <p className="mt-3 text-xs text-slate-500">
                QR total reference:{" "}
                <span className="font-mono text-slate-400">
                  {qrData.TotInvVal}
                </span>
              </p>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
