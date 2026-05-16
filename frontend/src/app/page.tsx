import Link from "next/link";
import styles from "./page.module.css";

const BADGES = ["142/165 audit score", "100 tests", "Sui Overflow 2026"] as const;

const STEPS = [
  { n: "1", title: "Deposit", desc: "Standard amounts (100/500/1000). Genesis commitment created on-chain." },
  { n: "2", title: "Prove", desc: "Groth16 in browser via snarkjs WASM (~2s). 11 constraints verified." },
  { n: "3", title: "Transfer", desc: "UTXO consumed, nullifier stored, new commitment created." },
  { n: "4", title: "Comply", desc: "Above threshold: dual proof (transfer + KYC). Auditor encryption via ECDH." },
  { n: "5", title: "Withdraw", desc: "ZK-proven exit. No admin needed. Recipient bound to proof." },
] as const;

const CIRCUIT_ROWS = [
  { signal: "oldCommitment", type: "input", desc: "Previous UTXO commitment (Poseidon hash)" },
  { signal: "newCommitment", type: "output", desc: "New UTXO commitment after transfer" },
  { signal: "nullifier", type: "output", desc: "Poseidon(secret, epoch, randOld) -- prevents double-spend" },
  { signal: "cumulativeOld", type: "input", desc: "Running total before this transfer" },
  { signal: "cumulativeNew", type: "output", desc: "cumulativeOld + amount (range-checked)" },
  { signal: "txAmountHash", type: "output", desc: "Poseidon(amount, senderSecret) -- domain-separated" },
  { signal: "amount", type: "private", desc: "Transfer value (hidden from chain)" },
  { signal: "secret / rand", type: "private", desc: "User secret + randomness for commitment binding" },
] as const;

const AUDIT_CATEGORIES = [
  { label: "Smart Contract Security", score: 28, max: 30 },
  { label: "ZK Circuit Correctness", score: 27, max: 30 },
  { label: "Privacy Guarantees", score: 23, max: 25 },
  { label: "Compliance Architecture", score: 22, max: 25 },
  { label: "Frontend Security", score: 18, max: 20 },
  { label: "Operational Security", score: 12, max: 15 },
  { label: "Testing Coverage", score: 12, max: 20 },
] as const;

const AUDIT_STATS = ["5 audit loops", "0 critical remaining", "100 Move tests", "349+ total tests"] as const;

const SEC_FEATURES = [
  "VK timelock (1-epoch delay for updates)",
  "Note-based nullifiers (unique per transfer)",
  "Identity-bound commitments (theft-proof)",
  "Standard deposit amounts (correlation resistance)",
  "Encrypted auditor storage (ECDH + AES-GCM)",
  "Privacy events (no sender/recipient/amount leaked)",
  "Content Security Policy (strict CSP headers)",
  "Sponsored tx relayer (hides sender address)",
] as const;

type ComparisonRating = "Leading" | "Competitive" | "Behind";

interface ComparisonRow {
  readonly protocol: string;
  readonly compliance: ComparisonRating;
  readonly anonymity: ComparisonRating;
  readonly proving: ComparisonRating;
}

const COMPARISONS: readonly ComparisonRow[] = [
  { protocol: "Veil", compliance: "Leading", anonymity: "Competitive", proving: "Leading" },
  { protocol: "Tornado Cash", compliance: "Behind", anonymity: "Leading", proving: "Competitive" },
  { protocol: "Zcash", compliance: "Behind", anonymity: "Leading", proving: "Competitive" },
  { protocol: "Aztec", compliance: "Competitive", anonymity: "Leading", proving: "Leading" },
  { protocol: "Railgun", compliance: "Competitive", anonymity: "Competitive", proving: "Competitive" },
  { protocol: "Penumbra", compliance: "Behind", anonymity: "Leading", proving: "Competitive" },
] as const;

const RATING_STYLE: Record<ComparisonRating, string> = {
  Leading: styles.cellAccent,
  Competitive: styles.cellMuted,
  Behind: styles.cellWarn,
};

const CONTRIBUTIONS = [
  { title: "Cumulative spending proofs", desc: "Track total spending across an epoch without revealing individual transactions." },
  { title: "Dual-proof compliance", desc: "Above threshold: submit both transfer proof and compliance proof in one transaction." },
  { title: "Context-bound credential nullifiers", desc: "Credential nullifiers are unique per transfer, preventing cross-context tracking." },
  { title: "Auditor encryption (ECDH P-256 + AES-GCM)", desc: "Encrypted audit payloads readable only by designated auditor keys." },
  { title: "ZK withdrawal with recipient binding", desc: "Withdrawal proof binds to a specific recipient address -- no front-running." },
  { title: "Configurable epoch duration per pool", desc: "Each pool sets its own epoch length for cumulative spending resets." },
] as const;

const TECH_STACK = [
  "Circom 2.1", "Sui Move 2024", "sui::groth16",
  "Next.js 14", "dapp-kit v2", "snarkjs WASM",
] as const;

function RatingCell({ rating }: { readonly rating: ComparisonRating }) {
  return <td className={RATING_STYLE[rating]}>{rating}</td>;
}

export default function Home() {
  return (
    <main className={styles.main}>
      {/* 1. Hero */}
      <section className={styles.hero}>
        <h1 className={styles.title}>VEIL</h1>
        <p className={styles.subtitle}>Private Payments on Sui</p>
        <p className={styles.oneliner}>
          Anonymous below threshold. Compliant above. Zero-knowledge.
        </p>
        <Link href="/dashboard" className={styles.launchButton}>
          Launch App
        </Link>
        <div className={styles.badges}>
          {BADGES.map((b) => (
            <span key={b} className={styles.badge}>{b}</span>
          ))}
        </div>
      </section>

      {/* 2. Problem / Solution */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Problem / Solution</h2>
        <div className={styles.twoCol}>
          <div className={styles.colCard}>
            <div className={styles.colCardAccentDanger} />
            <span className={styles.colLabel}>The Problem</span>
            <p className={styles.colText}>
              Every on-chain transaction is public. Balances, transfers, and
              counterparties are visible to anyone. Financial surveillance is
              the default on transparent blockchains.
            </p>
          </div>
          <div className={styles.colCard}>
            <div className={styles.colCardAccent} />
            <span className={styles.colLabel}>The Solution</span>
            <p className={styles.colText}>
              Cumulative spending proofs let users transact privately below a
              configurable threshold. Above it, tiered compliance kicks in --
              dual ZK proofs bind KYC credentials without revealing identity.
            </p>
          </div>
        </div>
      </section>

      {/* 3. How It Works */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>How It Works</h2>
        <div className={styles.stepsGrid}>
          {STEPS.map((s) => (
            <article key={s.n} className={styles.stepCard}>
              <div className={styles.stepAccent} />
              <span className={styles.stepNumber}>{s.n}</span>
              <h3 className={styles.stepName}>{s.title}</h3>
              <p className={styles.stepDesc}>{s.desc}</p>
            </article>
          ))}
        </div>
      </section>

      {/* 4. Architecture */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Architecture</h2>
        <div className={styles.codeBlock}>
          <pre>
            <span className={styles.codeAccent}>USER BROWSER</span>
            {" -> snarkjs WASM -> Groth16 proof -> "}
            <span className={styles.codeAccent}>proof-converter</span>
            {"\n"}
            {"                                                    |\n"}
            <span className={styles.codeAccent}>SUI MOVE CONTRACT</span>
            {" <- proof_bytes + public_inputs_bytes\n"}
            {"  |-- Groth16 Verifier (BN254 native)\n"}
            {"  |-- Nullifier Set (dynamic fields)\n"}
            {"  |-- UTXO Commitments (consume old, create new)\n"}
            {"  '-- Pool { balance, VKs, threshold, epoch_duration }"}
          </pre>
        </div>
      </section>

      {/* 5. Circuit Constraints */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Circuit Constraints</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Signal</th>
                <th>Type</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {CIRCUIT_ROWS.map((r) => (
                <tr key={r.signal}>
                  <td className={styles.cellAccent}>{r.signal}</td>
                  <td>{r.type}</td>
                  <td>{r.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.colText}>
          Transfer: 11 constraints | Compliance: 10 constraints (Merkle depth 20) | Withdraw: 8 constraints
        </p>
      </section>

      {/* 6. Security & Audit Score */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Security &amp; Audit</h2>
        <div className={styles.scoreHeader}>
          <span className={styles.scoreValue}>142/165</span>
          <span className={styles.scoreLabel}>overall score (86%)</span>
        </div>
        <div className={styles.auditStats}>
          {AUDIT_STATS.map((s) => (
            <span key={s} className={styles.auditStat}>{s}</span>
          ))}
        </div>
        <div className={styles.scoreGrid}>
          {AUDIT_CATEGORIES.map((c) => (
            <div key={c.label} className={styles.scoreRow}>
              <span className={styles.scoreRowLabel}>{c.label}</span>
              <div className={styles.scoreBar}>
                <div
                  className={styles.scoreBarFill}
                  style={{ width: `${(c.score / c.max) * 100}%` }}
                />
              </div>
              <span className={styles.scoreRowValue}>{c.score}/{c.max}</span>
            </div>
          ))}
        </div>
        <div className={styles.secFeatures}>
          {SEC_FEATURES.map((f) => (
            <span key={f} className={styles.secFeature}>{f}</span>
          ))}
        </div>
      </section>

      {/* 7. SOTA Comparison */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>SOTA Comparison</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Protocol</th>
                <th>Compliance</th>
                <th>Anonymity Set</th>
                <th>Proving System</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISONS.map((r) => (
                <tr key={r.protocol}>
                  <td className={r.protocol === "Veil" ? styles.cellAccent : undefined}>
                    {r.protocol}
                  </td>
                  <RatingCell rating={r.compliance} />
                  <RatingCell rating={r.anonymity} />
                  <RatingCell rating={r.proving} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 8. Novel Contributions */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Novel Contributions</h2>
        <div className={styles.novelList}>
          {CONTRIBUTIONS.map((c, i) => (
            <div key={c.title} className={styles.novelItem}>
              <span className={styles.novelNumber}>{i + 1}</span>
              <div className={styles.novelContent}>
                <span className={styles.novelTitle}>{c.title}</span>
                <span className={styles.novelDesc}>{c.desc}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 9. Tech Stack */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Tech Stack</h2>
        <div className={styles.techGrid}>
          {TECH_STACK.map((t) => (
            <div key={t} className={styles.techItem}>{t}</div>
          ))}
        </div>
      </section>

      {/* 10. Footer */}
      <footer className={styles.footer}>
        <span>Built for Sui Overflow 2026 -- DeFi &amp; Payments Track</span>
        <div className={styles.footerLinks}>
          <a href="https://github.com/veil-protocol/veil" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href="/docs" target="_blank" rel="noopener noreferrer">
            Docs
          </a>
          <a href="/docs/demo-guide" target="_blank" rel="noopener noreferrer">
            Demo Guide
          </a>
        </div>
      </footer>
    </main>
  );
}
