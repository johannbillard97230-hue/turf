import axios from "axios";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  CircleDot,
  Clock,
  Database,
  Flag,
  History,
  Lock,
  Minus,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  XCircle,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import "@/App.css";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

const SOURCE_LABELS = {
  pronostics_valeur: "Pronostics-Turf · Valeur",
  pronostics_citations: "Pronostics-Turf · Citations",
  paris_turf: "Paris-Turf · Sexe/Âge & Musique",
  pmu_cotes: "PMU.fr · Cotes officielles",
};

const STATUS_META = {
  ok: {
    text: "OK",
    color: "text-emerald-300",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
    dot: "bg-emerald-400",
    Icon: CheckCircle2,
  },
  partial: {
    text: "Partiel",
    color: "text-amber-300",
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    dot: "bg-amber-400",
    Icon: AlertTriangle,
  },
  error: {
    text: "Échec",
    color: "text-rose-300",
    bg: "bg-rose-500/10",
    border: "border-rose-500/30",
    dot: "bg-rose-500",
    Icon: XCircle,
  },
};

function NDBadge() {
  return (
    <span
      data-testid="nd-badge"
      className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-zinc-800 text-zinc-400 border border-zinc-700 tracking-widest"
    >
      N/D
    </span>
  );
}

function formatPct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return `${Number(v).toFixed(1).replace(".", ",")} %`;
}

function RankMedal({ rank }) {
  const base = "inline-flex items-center justify-center w-7 h-7 rounded-full font-mono font-bold text-xs tabular border";
  if (rank === 1) return <span className={`${base} rank-gold border-amber-400/50 bg-amber-500/10`}>1</span>;
  if (rank === 2) return <span className={`${base} rank-silver border-zinc-300/40 bg-zinc-300/5`}>2</span>;
  if (rank === 3) return <span className={`${base} rank-bronze border-orange-400/40 bg-orange-500/5`}>3</span>;
  return <span className={`${base} text-zinc-400 border-zinc-700 bg-zinc-900`}>{rank}</span>;
}

function SexeAgeBadge({ value }) {
  if (!value) return <NDBadge />;
  const first = value[0];
  const color =
    first === "F"
      ? "bg-pink-500/10 text-pink-300 border-pink-500/30"
      : first === "H"
      ? "bg-sky-500/10 text-sky-300 border-sky-500/30"
      : first === "M"
      ? "bg-violet-500/10 text-violet-300 border-violet-500/30"
      : "bg-zinc-800 text-zinc-400 border-zinc-700";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-mono font-bold tracking-wider border ${color}`}>
      {value}
    </span>
  );
}

const TYPE_LABEL = {
  a: "Attelé",
  m: "Monté",
  h: "Haie",
  s: "Steeple",
  p: "Plat",
  c: "Cross",
  o: "Obstacle",
};

function LastOutingsCell({ performances, last3 }) {
  if (!last3) return <NDBadge />;
  const parts = last3.split(" - ");
  const perfs = Array.isArray(performances) ? performances.slice(0, 3) : [];
  return (
    <div className="flex items-center gap-1.5 font-mono text-sm">
      {parts.map((p, i) => {
        const pos = p.replace(/[a-z]+$/i, "");
        const typ = p.slice(pos.length);
        let cls = "bg-zinc-800 text-zinc-300 border-zinc-700";
        if (pos === "1") cls = "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
        else if (pos === "2" || pos === "3") cls = "bg-amber-500/15 text-amber-300 border-amber-500/40";
        else if (/^[0-9]+$/.test(pos) && parseInt(pos, 10) > 5) cls = "bg-rose-500/10 text-rose-300 border-rose-500/30";
        else if (/^D/.test(pos)) cls = "bg-rose-600/15 text-rose-400 border-rose-500/40";
        const year = perfs[i]?.year;
        const typeLabel = TYPE_LABEL[typ] || typ;
        const title = year ? `${pos}${typ} · ${typeLabel} · ${year}` : `${pos}${typ} · ${typeLabel}`;
        return (
          <span
            key={i}
            title={title}
            className={`inline-flex items-center justify-center px-2 py-0.5 rounded-md border font-bold text-xs ${cls}`}
          >
            {p}
          </span>
        );
      })}
    </div>
  );
}

function CordeCell({ value, status }) {
  if (status === "na") {
    return (
      <span
        data-testid="corde-na"
        className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-mono font-bold tracking-widest bg-zinc-900 text-zinc-500 border border-zinc-800"
        title="Discipline sans numéro de corde (trot attelé/monté)"
      >
        N/A
      </span>
    );
  }
  if (status === "nd" || value === null || value === undefined) {
    return <NDBadge />;
  }
  return (
    <span className="inline-flex items-center justify-center w-9 h-9 rounded-md bg-sky-500/10 text-sky-200 border border-sky-500/30 font-mono font-extrabold text-base tabular">
      {value}
    </span>
  );
}

function formatTimeHMS(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: "Europe/Paris",
    });
  } catch {
    return null;
  }
}

function CoteCell({ cote, animKey, horseNumber }) {
  const prevKeyRef = useRef(null);
  const [flash, setFlash] = useState(null); // "up" | "down" | null

  useEffect(() => {
    if (!cote || !cote.cote) return;
    const prev = prevKeyRef.current;
    const key = `${animKey}:${cote.cote_num ?? "nd"}`;
    if (prev !== null && prev !== key && cote.direction && cote.direction !== "STABLE" && cote.direction !== "NOUVEAU") {
      setFlash(cote.direction === "BAISSE" ? "down" : "up");
      const t = setTimeout(() => setFlash(null), 1600);
      prevKeyRef.current = key;
      return () => clearTimeout(t);
    }
    prevKeyRef.current = key;
  }, [animKey, cote]);

  if (!cote || !cote.cote) return <NDBadge />;
  const flashCls = flash === "down" ? "cote-anim-down" : flash === "up" ? "cote-anim-up" : "";
  const isNew = cote.is_first_sighting;
  const coteTime = formatTimeHMS(cote.cote_time) || formatTimeHMS(cote.last_update);
  const srcShort = cote.source === "PMU.fr" ? "PMU" : cote.source || "";
  const rapportTag = cote.type_rapport === "DIRECT" ? "LIVE" : cote.type_rapport === "REFERENCE" ? "REF" : null;

  return (
    <div
      data-testid={`horse-cote-${horseNumber}`}
      className={`inline-flex flex-col gap-0.5 px-2 py-1 rounded-md ${flashCls}`}
      title={
        [
          cote.source && `Source : ${cote.source}`,
          cote.type_rapport && `Rapport : ${cote.type_rapport}`,
          cote.cote_time && `Cote PMU : ${new Date(cote.cote_time).toLocaleString("fr-FR")}`,
          cote.last_update && `Récup. : ${new Date(cote.last_update).toLocaleString("fr-FR")}`,
          cote.trend && `Tendance source : ${cote.trend} ${cote.trend_pct?.toFixed?.(2) ?? ""} %`,
        ]
          .filter(Boolean)
          .join("\n")
      }
    >
      <span
        key={cote.cote}
        data-testid={`horse-cote-value-${horseNumber}`}
        className="font-mono font-extrabold text-base text-zinc-100 tabular leading-none cote-swap"
      >
        {cote.cote}
      </span>
      <div className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-widest text-emerald-400/70 leading-none">
        {srcShort && <span data-testid={`horse-cote-source-${horseNumber}`}>{srcShort}</span>}
        {rapportTag && (
          <span
            className={
              rapportTag === "LIVE"
                ? "text-emerald-300"
                : "text-amber-300"
            }
          >
            · {rapportTag}
          </span>
        )}
      </div>
      {coteTime && (
        <span
          data-testid={`horse-cote-time-${horseNumber}`}
          className="font-mono text-[9px] text-zinc-500 leading-none"
        >
          {coteTime}
        </span>
      )}
      {isNew && (
        <span className="font-mono text-[9px] uppercase tracking-widest text-amber-300 flex items-center gap-1">
          <Sparkles className="w-2.5 h-2.5" /> Nouveau
        </span>
      )}
    </div>
  );
}

function formatSignedPct(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return "";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1).replace(".", ",")} %`;
}

function formatSignedDelta(d) {
  if (d === null || d === undefined || Number.isNaN(d)) return "";
  const sign = d > 0 ? "+" : "";
  return `${sign}${Math.abs(d) < 1 ? d.toFixed(1).replace(".", ",") : Math.round(d)}`;
}

function EvolutionCell({ cote, horseNumber }) {
  if (!cote || !cote.direction) return <NDBadge />;
  if (cote.is_first_sighting) {
    return (
      <span
        data-testid={`horse-evolution-${horseNumber}`}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-amber-500/30 bg-amber-500/5 text-amber-200 font-mono text-[11px] uppercase tracking-widest"
      >
        <Sparkles className="w-3 h-3" /> Nouveau
      </span>
    );
  }
  if (cote.direction === "STABLE") {
    return (
      <span
        data-testid={`horse-evolution-${horseNumber}`}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-zinc-700 bg-zinc-900/50 text-zinc-400 font-mono text-xs"
      >
        <Minus className="w-3 h-3" />
        <span>{cote.previous_cote} → {cote.cote}</span>
      </span>
    );
  }
  const isDown = cote.direction === "BAISSE";
  const color = isDown
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
    : "border-rose-500/40 bg-rose-500/10 text-rose-200";
  const Arrow = isDown ? ArrowDownRight : ArrowUpRight;
  return (
    <div
      data-testid={`horse-evolution-${horseNumber}`}
      className={`inline-flex flex-col gap-0.5 px-2 py-1 rounded-md border ${color} font-mono`}
    >
      <div className="flex items-center gap-1.5 text-sm font-bold leading-none">
        <Arrow className="w-3.5 h-3.5" />
        <span className="tabular">{cote.previous_cote} → {cote.cote}</span>
      </div>
      <div className="flex items-center gap-1.5 text-[10px] leading-none opacity-85">
        <span className="tabular font-semibold">{formatSignedDelta(cote.delta)}</span>
        <span className="text-zinc-500">·</span>
        <span className="tabular">{formatSignedPct(cote.pct_change)}</span>
      </div>
    </div>
  );
}

function WinRateCell({ value, horse, maxVictoires }) {
  if (value === null || value === undefined) return <NDBadge />;
  const pct = Math.max(0, Math.min(100, Number(value)));
  const hasDetail =
    horse.victoires !== null &&
    horse.victoires !== undefined &&
    horse.places !== null &&
    horse.places !== undefined &&
    horse.courses !== null &&
    horse.courses !== undefined;
  const isMaxVict =
    maxVictoires !== null &&
    maxVictoires !== undefined &&
    maxVictoires > 0 &&
    horse.victoires === maxVictoires;
  return (
    <div className="w-full flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono font-semibold text-amber-200 tabular text-sm">{formatPct(value)}</span>
        {hasDetail && (
          <span className="font-mono text-[10px] text-zinc-500 whitespace-nowrap">
            (
            <span
              data-testid={`victoires-${horse.number}`}
              className={
                isMaxVict
                  ? "font-bold text-emerald-400"
                  : "text-zinc-400"
              }
              title={isMaxVict ? "Plus grand nombre de victoires de la course" : undefined}
            >
              {horse.victoires} V
            </span>
            {" + "}
            <span className="text-zinc-400">{horse.places} P</span>
            {") / "}
            <span className="text-zinc-400">{horse.courses} courses</span>
          </span>
        )}
      </div>
      <div className="pbar">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ValueCell({ value, maxValue }) {
  if (value === null || value === undefined) return <NDBadge />;
  const pct = maxValue ? Math.max(5, Math.round((value / maxValue) * 100)) : 50;
  return (
    <div className="w-full flex flex-col gap-1">
      <span className="font-mono font-extrabold text-amber-300 tabular text-base leading-none">{value}</span>
      <div className="pbar">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function CitationsCell({ value, maxValue }) {
  if (value === null || value === undefined) return <NDBadge />;
  if (value === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-mono font-bold tracking-wider bg-zinc-900 text-zinc-500 border border-zinc-800"
        title="Ce cheval n'est cité par aucun pronostic de la presse"
      >
        0
        <span className="text-[9px] uppercase tracking-widest text-zinc-600">non cité</span>
      </span>
    );
  }
  const pct = maxValue ? Math.max(5, Math.round((value / maxValue) * 100)) : 0;
  return (
    <div className="w-full flex flex-col gap-1">
      <span className="font-mono font-semibold text-emerald-300 tabular text-sm leading-none">{value}</span>
      <div className="pbar">
        <span style={{ width: `${pct}%`, background: "linear-gradient(90deg,#059669,#34D399)" }} />
      </div>
    </div>
  );
}

function SourceStatusPill({ sourceKey, info }) {
  const meta = STATUS_META[info?.status] || STATUS_META.error;
  const { Icon } = meta;
  return (
    <div
      data-testid={`source-status-${sourceKey.replace(/_/g, "-")}`}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${meta.border} ${meta.bg} hairline`}
      title={info?.message || info?.url}
    >
      <span className={`relative inline-flex w-2 h-2 rounded-full ${meta.dot}`}>
        <span className={`absolute inset-0 rounded-full ${meta.dot} led-dot opacity-70`} />
      </span>
      <div className="flex flex-col leading-tight">
        <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-mono">{SOURCE_LABELS[sourceKey]}</span>
        <span className={`text-xs font-mono font-bold ${meta.color} flex items-center gap-1`}>
          <Icon className="w-3 h-3" /> {meta.text}
        </span>
      </div>
    </div>
  );
}

function HeroBanner({ race, lastRefreshedAt }) {
  const name = race?.name || "Course du jour";
  const hippo = race?.hippodrome || "—";
  const date = race?.date;
  const partants = race?.partants;
  const distance = race?.distance;
  const allocation = race?.allocation;
  const type = race?.type;
  return (
    <section
      data-testid="race-hero-banner"
      className="relative overflow-hidden rounded-2xl border border-emerald-900/40 bg-gradient-to-br from-[#0C1510] via-[#111C16] to-[#0A0D0B] p-6 sm:p-8 shadow-2xl mb-6 fade-up"
    >
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-amber-400/50 to-transparent" />
      <div className="absolute -top-20 -right-20 w-72 h-72 bg-emerald-500/5 rounded-full blur-3xl" />
      <div className="absolute -bottom-24 -left-16 w-72 h-72 bg-amber-500/5 rounded-full blur-3xl" />
      <div className="relative z-10 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono font-bold uppercase tracking-widest bg-amber-500/10 border border-amber-500/30 text-amber-300">
            <Flag className="w-3 h-3" /> Quinté+ du jour
          </span>
          {date && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono text-zinc-400 border border-zinc-800 bg-zinc-900/50">
              <Clock className="w-3 h-3" /> {date}
            </span>
          )}
          {lastRefreshedAt && (
            <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-mono text-emerald-300/80 border border-emerald-500/20 bg-emerald-500/5 uppercase tracking-widest">
              <CircleDot className="w-3 h-3" /> Dernière synchro: {new Date(lastRefreshedAt).toLocaleTimeString("fr-FR")}
            </span>
          )}
        </div>
        <h1 data-testid="race-header-title" className="font-display uppercase text-3xl sm:text-5xl font-black tracking-tight text-white leading-[0.95]">
          {name}
        </h1>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm font-mono text-zinc-400">
          <span>
            <span className="text-emerald-400/80 text-[10px] uppercase tracking-widest mr-1.5">Hippodrome</span>
            <span className="text-zinc-100 font-semibold">{hippo}</span>
          </span>
          {partants && (
            <span>
              <span className="text-emerald-400/80 text-[10px] uppercase tracking-widest mr-1.5">Partants</span>
              <span className="text-zinc-100 font-semibold">{partants}</span>
            </span>
          )}
          {distance && (
            <span>
              <span className="text-emerald-400/80 text-[10px] uppercase tracking-widest mr-1.5">Distance</span>
              <span className="text-zinc-100 font-semibold">{distance}</span>
            </span>
          )}
          {allocation && (
            <span>
              <span className="text-emerald-400/80 text-[10px] uppercase tracking-widest mr-1.5">Allocation</span>
              <span className="text-zinc-100 font-semibold">{allocation}</span>
            </span>
          )}
          {type && (
            <span>
              <span className="text-emerald-400/80 text-[10px] uppercase tracking-widest mr-1.5">Discipline</span>
              <span className="text-zinc-100 font-semibold">{type}</span>
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function AlertBanner({ warnings }) {
  if (!warnings || warnings.length === 0) return null;
  const [headline, ...details] = warnings;
  return (
    <div
      data-testid="alert-banner"
      className="border border-amber-500/30 bg-amber-950/15 rounded-xl p-4 mb-6 fade-up"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-400" />
        <div className="flex-1 flex flex-col gap-1.5">
          <p className="font-semibold text-amber-300 uppercase tracking-widest text-[10px] font-mono">
            Rapport de récupération
          </p>
          <p
            data-testid="alert-headline"
            className="font-mono text-sm text-amber-100 font-semibold"
          >
            {headline}
          </p>
          {details.length > 0 && (
            <ul className="list-disc list-inside space-y-0.5 text-amber-200/80 text-xs">
              {details.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
              <li className="text-zinc-400">
                Les cellules marquées{" "}
                <span className="font-mono text-zinc-300">N/D</span> indiquent une donnée indisponible.
                Un cheval « non cité » affiche{" "}
                <span className="font-mono text-zinc-300">0</span>.
              </li>
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function HistorySidebar({ open, onClose, items, onLoad }) {
  return (
    <aside
      className={`fixed inset-y-0 right-0 z-40 w-80 max-w-[90vw] bg-[#0D1310] border-l border-emerald-900/40 shadow-2xl transition-transform duration-300 ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
      data-testid="history-sidebar"
    >
      <div className="flex items-center justify-between px-5 py-4 border-b border-emerald-900/40">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-amber-300" />
          <span className="font-display uppercase tracking-wider text-sm font-bold text-white">Historique</span>
        </div>
        <button
          onClick={onClose}
          data-testid="history-close-button"
          className="text-zinc-400 hover:text-white text-xs font-mono uppercase tracking-wider"
        >
          Fermer
        </button>
      </div>
      <div className="overflow-y-auto h-[calc(100%-57px)] p-3 space-y-2">
        {items.length === 0 && (
          <p className="text-xs text-zinc-500 font-mono p-4 text-center">Aucune analyse enregistrée pour le moment.</p>
        )}
        {items.map((item) => (
          <button
            key={item.id}
            data-testid={`history-item-${item.id}`}
            onClick={() => onLoad(item.id)}
            className="w-full text-left p-3 rounded-lg border border-emerald-900/40 bg-emerald-950/10 hover:bg-emerald-900/15 transition-colors"
          >
            <div className="text-[10px] font-mono uppercase tracking-widest text-emerald-400/80">
              {new Date(item.created_at).toLocaleString("fr-FR")}
            </div>
            <div className="font-heading text-sm font-semibold text-zinc-100 mt-1 line-clamp-1">
              {item.race?.name || "Course"}
            </div>
            <div className="text-xs text-zinc-500 mt-0.5">
              {item.race?.hippodrome || "—"} · {item.nb_horses} partants
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

function Table({ horses, maxVictoires, animKey }) {
  const maxValue = useMemo(
    () => horses.reduce((m, h) => Math.max(m, h.valeur || 0), 0),
    [horses]
  );
  const maxCitations = useMemo(
    () => horses.reduce((m, h) => Math.max(m, h.citations || 0), 0),
    [horses]
  );

  return (
    <div
      data-testid="turf-analysis-table"
      className="bg-[#111713] border border-emerald-900/40 rounded-2xl shadow-xl overflow-hidden mb-8 fade-up"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-emerald-900/40 bg-[#0D1310]">
        <div className="flex items-center gap-2 text-emerald-300/80">
          <Lock className="w-3.5 h-3.5" />
          <span className="font-mono text-[11px] uppercase tracking-widest">
            Tri verrouillé — Valeur décroissante (Méthode propriétaire)
          </span>
        </div>
        <div className="hidden sm:flex items-center gap-2 text-zinc-500 font-mono text-[11px]">
          <TrendingDown className="w-3.5 h-3.5" />
          <span>Max → Min</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-[#0E1512] border-b border-emerald-900/40">
              <th className="font-mono text-[10px] uppercase tracking-widest text-emerald-300/70 text-left px-4 py-3 w-16">Rang</th>
              <th className="font-mono text-[10px] uppercase tracking-widest text-emerald-300/70 text-left px-4 py-3">N° · Cheval</th>
              <th className="font-mono text-[10px] uppercase tracking-widest text-amber-300/80 text-left px-4 py-3 w-28">Valeur ↓</th>
              <th className="font-mono text-[10px] uppercase tracking-widest text-zinc-200/80 text-left px-4 py-3 w-24">Cote</th>
              <th className="font-mono text-[10px] uppercase tracking-widest text-emerald-300/70 text-left px-4 py-3 w-56">Évolution cote</th>
              <th className="font-mono text-[10px] uppercase tracking-widest text-emerald-300/70 text-left px-4 py-3 w-24">Citations</th>
              <th className="font-mono text-[10px] uppercase tracking-widest text-sky-300/80 text-left px-4 py-3 w-20">Corde</th>
              <th className="font-mono text-[10px] uppercase tracking-widest text-emerald-300/70 text-left px-4 py-3 w-24">Sexe · Âge</th>
              <th className="font-mono text-[10px] uppercase tracking-widest text-emerald-300/70 text-left px-4 py-3 w-44">Taux de réussite</th>
              <th className="font-mono text-[10px] uppercase tracking-widest text-emerald-300/70 text-left px-4 py-3 w-56">3 dernières sorties</th>
            </tr>
          </thead>
          <tbody>
            {horses.map((h, idx) => (
              <tr
                key={`${h.number}-${idx}`}
                data-testid={`table-row-horse-${h.number}`}
                className="table-row border-b border-emerald-950/40 last:border-0 transition-colors"
              >
                <td className="px-4 py-3 align-middle">
                  <RankMedal rank={idx + 1} />
                </td>
                <td className="px-4 py-3 align-middle">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex items-center justify-center w-9 h-9 rounded-md bg-zinc-900 border border-zinc-700 font-display text-base font-extrabold text-amber-200 tabular">
                      {h.number}
                    </span>
                    <div className="flex flex-col leading-tight">
                      <span className="font-heading text-sm font-semibold text-zinc-100">{h.name || "—"}</span>
                      {(h.jockey || h.entraineur) && (
                        <span className="text-[10px] font-mono text-zinc-500 mt-0.5">
                          {h.jockey && <span>{h.jockey}</span>}
                          {h.jockey && h.entraineur && <span className="mx-1 text-zinc-700">·</span>}
                          {h.entraineur && <span>{h.entraineur}</span>}
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 align-middle">
                  <div data-testid={`horse-valeur-${h.number}`}>
                    <ValueCell value={h.valeur} maxValue={maxValue} />
                  </div>
                </td>
                <td className="px-4 py-3 align-middle">
                  <CoteCell cote={h.cote} animKey={animKey} horseNumber={h.number} />
                </td>
                <td className="px-4 py-3 align-middle">
                  <EvolutionCell cote={h.cote} horseNumber={h.number} />
                </td>
                <td className="px-4 py-3 align-middle">
                  <div data-testid={`horse-citations-${h.number}`}>
                    <CitationsCell value={h.citations} maxValue={maxCitations} />
                  </div>
                </td>
                <td className="px-4 py-3 align-middle" data-testid={`horse-corde-${h.number}`}>
                  <CordeCell value={h.corde} status={h.corde_status} />
                </td>
                <td className="px-4 py-3 align-middle" data-testid={`horse-sexe-age-${h.number}`}>
                  <SexeAgeBadge value={h.sexe_age} />
                </td>
                <td className="px-4 py-3 align-middle" data-testid={`horse-win-rate-${h.number}`}>
                  <WinRateCell value={h.win_rate} horse={h} maxVictoires={maxVictoires} />
                </td>
                <td className="px-4 py-3 align-middle" data-testid={`horse-last3-${h.number}`}>
                  <LastOutingsCell performances={h.performances} last3={h.last3} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function App() {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  const loadAnalysis = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get(`${API}/analysis/current`);
      setAnalysis(data);
      setLastRefreshedAt(new Date().toISOString());
      const errCount = Object.values(data.sources || {}).filter((s) => s.status === "error").length;
      if (errCount) {
        toast.warning(`Analyse chargée · ${errCount} source(s) en échec`);
      } else {
        toast.success(`Analyse chargée · ${data.horses.length} chevaux`);
      }
    } catch (e) {
      console.error(e);
      toast.error("Impossible de récupérer les données. Réessayez.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const { data } = await axios.get(`${API}/analysis/history`);
      setHistory(data);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const saveAnalysis = useCallback(async () => {
    setSaving(true);
    try {
      const { data } = await axios.post(`${API}/analysis/save`);
      setAnalysis(data);
      setLastRefreshedAt(new Date().toISOString());
      toast.success("Analyse enregistrée en base ✓");
      loadHistory();
    } catch (e) {
      console.error(e);
      toast.error("Erreur lors de la sauvegarde.");
    } finally {
      setSaving(false);
    }
  }, [loadHistory]);

  const loadHistoricItem = useCallback(async (id) => {
    setLoading(true);
    try {
      const { data } = await axios.get(`${API}/analysis/${id}`);
      setAnalysis(data);
      setHistoryOpen(false);
      toast.success("Analyse archivée restaurée");
    } catch (e) {
      console.error(e);
      toast.error("Impossible de charger cette analyse.");
    } finally {
      setLoading(false);
    }
  }, []);

  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    loadAnalysis();
    loadHistory();
  }, [loadAnalysis, loadHistory]);

  const sources = analysis?.sources || {};

  return (
    <div className="grain min-h-screen relative">
      <Toaster
        theme="dark"
        position="top-right"
        toastOptions={{
          style: {
            background: "#0E1512",
            border: "1px solid rgba(16,185,129,0.25)",
            color: "#E4E4E7",
            fontFamily: "IBM Plex Sans, sans-serif",
          },
        }}
      />

      <HistorySidebar
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        items={history}
        onLoad={loadHistoricItem}
      />

      {/* Top nav */}
      <header className="sticky top-0 z-30 backdrop-blur-xl bg-[#0A0D0B]/85 border-b border-emerald-900/40">
        <div className="max-w-[1500px] mx-auto px-4 lg:px-8 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center shadow-lg shadow-emerald-900/50">
              <ShieldCheck className="w-5 h-5 text-black" />
            </div>
            <div className="leading-tight">
              <div className="font-display uppercase text-lg sm:text-xl font-black tracking-tight text-white">
                TurfMetrics <span className="text-amber-300">Pro</span>
              </div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-emerald-400/70">
                Moteur d'analyse PMU · V1
              </div>
            </div>
          </div>

          <div className="hidden lg:flex items-center gap-2">
            {Object.entries(sources).map(([key, info]) => (
              <SourceStatusPill key={key} sourceKey={key} info={info} />
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              data-testid="history-toggle-button"
              onClick={() => setHistoryOpen(true)}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-700 bg-zinc-900/60 hover:bg-zinc-800 text-zinc-300 text-xs font-mono uppercase tracking-wider transition"
            >
              <History className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Historique</span>
            </button>
            <button
              data-testid="save-race-button"
              onClick={saveAnalysis}
              disabled={saving || !analysis}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-amber-200 text-xs font-mono uppercase tracking-wider transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className={`w-3.5 h-3.5 ${saving ? "spin-slow" : ""}`} />
              <span className="hidden sm:inline">{saving ? "Sauvegarde…" : "Enregistrer"}</span>
            </button>
            <button
              data-testid="refresh-scrape-button"
              onClick={loadAnalysis}
              disabled={loading}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-emerald-500/40 bg-gradient-to-br from-emerald-500/20 to-emerald-700/10 hover:from-emerald-500/30 hover:to-emerald-700/20 text-emerald-200 text-xs font-mono uppercase tracking-wider transition disabled:opacity-60 shadow-lg shadow-emerald-900/30"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "spin-slow" : ""}`} />
              {loading ? "Scraping en cours…" : "Rafraîchir les données"}
            </button>
          </div>
        </div>

        {/* Mobile: sources status row */}
        <div className="lg:hidden overflow-x-auto border-t border-emerald-900/40">
          <div className="flex items-center gap-2 px-4 py-3 whitespace-nowrap">
            {Object.entries(sources).map(([key, info]) => (
              <SourceStatusPill key={key} sourceKey={key} info={info} />
            ))}
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-[1500px] mx-auto px-4 lg:px-8 py-6 lg:py-10">
        <HeroBanner race={analysis?.race} lastRefreshedAt={lastRefreshedAt} />
        <AlertBanner warnings={analysis?.warnings} />

        {loading && !analysis && (
          <div className="rounded-2xl border border-emerald-900/40 bg-[#111713] p-10 text-center text-zinc-400">
            <RefreshCw className="w-6 h-6 mx-auto spin-slow text-emerald-400" />
            <p className="mt-3 font-mono text-xs uppercase tracking-widest">
              Récupération en direct depuis Pronostics-Turf · Paris-Turf…
            </p>
          </div>
        )}

        {analysis && (
          <Table
            horses={analysis.horses}
            maxVictoires={analysis?.stats?.max_victoires ?? null}
            animKey={lastRefreshedAt || "init"}
          />
        )}

        <footer className="mt-10 pt-6 border-t border-emerald-900/40 text-xs text-zinc-500 font-mono flex flex-col sm:flex-row justify-between gap-3">
          <div className="flex items-center gap-2">
            <Database className="w-3.5 h-3.5" />
            <span>
              Sources: pronostics-turf.info · paris-turf.com — Données scrapées en direct.
              Les paris hippiques sont réservés aux personnes majeures.
            </span>
          </div>
          <div className="flex items-center gap-2 text-emerald-400/70">
            <Activity className="w-3.5 h-3.5" />
            <span>Architecture extensible · Prête pour futurs critères (cotes, forme jockey, terrain…)</span>
          </div>
        </footer>
      </main>
    </div>
  );
}

export default App;
