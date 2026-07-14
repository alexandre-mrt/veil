import Link from "next/link";
import styles from "./page.module.css";

const BADGES = ["124 Move tests", "Unaudited — testnet only", "Sui Overflow 2026"] as const;

const STEPS = [
  { n: "1", title: "Deposit", desc: "Standard amounts (100/500/1000). Genesis commitment created on-chain." },
  { n: "2", title: "Prove", desc: "Groth16 in browser via snarkjs WASM (~2s). 13,611 R1CS constraints." },
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

const LIMITATIONS = [
  "Sender is NOT anonymous — the user's wallet signs every transfer (red-team finding PRIV-002)",
  "No third-party audit. Self-review only. Testnet deployment, valueless test token",
  "Trusted setup is a single-contributor dev ceremony, not a real MPC",
  "Admin can drain the pool (timelocked withdrawal, or emergency withdrawal while frozen)",
  "Spending threshold is Sybil-bypassable: a fresh userSecret restarts the counter",
] as const;

const SEC_FEATURES = [
  "Timelocks on admin-mutable parameters",
  "Merkle accumulator (anonymity set = all commitments)",
  "Multi-sig governance (N-of-M signer approval)",
  "Wallet-signature key derivation (IndexedDB non-extractable)",
  "Relayer: API key auth + TX validation + rate limiting",
  "STRIDE threat model (37 threats, 30 controls)",
  "Content Security Policy (strict CSP headers)",
  "ZK withdrawal with recipient binding (no front-running)",
] as const;

type ComparisonRating = "Leading" | "Competitive" | "Behind";

interface ComparisonRow {
  readonly protocol: string;
  readonly compliance: ComparisonRating;
  readonly anonymity: ComparisonRating;
  readonly proving: ComparisonRating;
}

const COMPARISONS: readonly ComparisonRow[] = [
  { protocol: "Veil", compliance: "Leading", anonymity: "Behind", proving: "Competitive" },
  { protocol: "Tornado Cash", compliance: "Behind", anonymity: "Competitive", proving: "Competitive" },
  { protocol: "Zcash Orchard", compliance: "Competitive", anonymity: "Leading", proving: "Leading" },
  { protocol: "Railgun", compliance: "Competitive", anonymity: "Competitive", proving: "Competitive" },
  { protocol: "Penumbra", compliance: "Behind", anonymity: "Leading", proving: "Competitive" },
] as const;

const RATING_STYLE: Record<ComparisonRating, string> = {
  Leading: styles.cellAccent,
  Competitive: styles.cellMuted,
  Behind: styles.cellWarn,
};

const DESIGN_CHOICES = [
  { title: "Cumulative spending proofs", desc: "Track total spending across an epoch without revealing individual transactions." },
  { title: "Dual-proof compliance", desc: "Above threshold: submit both transfer proof and compliance proof in one transaction." },
  { title: "Context-bound credential nullifiers", desc: "Credential nullifiers are unique per transfer, preventing cross-context tracking." },
  { title: "Auditor encryption (ECDH P-256 + AES-GCM)", desc: "Encrypted audit payloads readable only by designated auditor keys." },
  { title: "ZK withdrawal with recipient binding", desc: "Withdrawal proof binds to a specific recipient address -- no front-running." },
  { title: "Merkle accumulator for commitment privacy", desc: "Depth-20 Poseidon tree. Anonymity set = all commitments ever inserted." },
  { title: "Multi-sig governance", desc: "N-of-M signer approval for admin operations. Configurable epoch duration per pool." },
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
        <p className={styles.subtitle}>Confidential compliance proofs on Sui</p>
        <p className={styles.oneliner}>
          Amounts hidden. Spending threshold proven. Sender still visible.
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
          R1CS constraints (snarkjs r1cs info) — transfer: 13,611 | compliance: 12,743 | withdraw: 3,058
        </p>
      </section>

      {/* 6. Security posture */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Security &amp; Limitations</h2>
        <div className={styles.secFeatures}>
          {SEC_FEATURES.map((f) => (
            <span key={f} className={styles.secFeature}>{f}</span>
          ))}
        </div>
        <ul className={styles.colText}>
          {LIMITATIONS.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
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

      {/* 8. Design choices */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Design Choices</h2>
        <div className={styles.novelList}>
          {DESIGN_CHOICES.map((c, i) => (
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
