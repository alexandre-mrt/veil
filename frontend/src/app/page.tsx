import Link from "next/link";
import styles from "./page.module.css";

const FEATURES = [
  {
    title: "Anonymous Transfers",
    description: "Send tokens without revealing amounts or identity",
  },
  {
    title: "Cumulative Proofs",
    description: "Track spending across an epoch without leaking individual transactions",
  },
  {
    title: "Tiered Compliance",
    description: "KYC kicks in only above the threshold — privacy by default",
  },
] as const;

const STEPS = [
  {
    number: "1",
    title: "Deposit",
    description:
      "Deposit VEIL tokens into shielded pool with genesis commitment.",
  },
  {
    number: "2",
    title: "ZK Proof",
    description:
      "Browser generates Groth16 proof (~2s, 11 constraints). Amount stays private.",
  },
  {
    number: "3",
    title: "Transfer",
    description:
      "Submit proof to Sui Move contract. Amount hidden. Threshold enforced.",
  },
  {
    number: "4",
    title: "Verify",
    description:
      "Sui verifies on-chain via native groth16. Nullifier stored. New commitment created.",
  },
] as const;

export default function Home() {
  return (
    <main className={styles.main}>
      <section className={styles.hero}>
        <h1 className={styles.title}>VEIL</h1>
        <p className={styles.subtitle}>Private payments on Sui</p>
        <p className={styles.description}>
          Anonymous below threshold. Compliant above. Zero-knowledge proofs protect your spending.
        </p>
        <Link href="/dashboard" className={styles.connectButton}>
          Launch App
        </Link>
      </section>

      <section className={styles.features}>
        {FEATURES.map((feature) => (
          <article key={feature.title} className={styles.card}>
            <div className={styles.cardAccentLine} />
            <h2 className={styles.cardTitle}>{feature.title}</h2>
            <p className={styles.cardDescription}>{feature.description}</p>
          </article>
        ))}
      </section>

      <section className={styles.howItWorks}>
        <h2 className={styles.howItWorksTitle}>How It Works</h2>
        <div className={styles.stepsGrid}>
          {STEPS.map((step) => (
            <article key={step.number} className={styles.stepCard}>
              <div className={styles.cardAccentLine} />
              <span className={styles.stepNumber}>{step.number}</span>
              <h3 className={styles.stepName}>{step.title}</h3>
              <p className={styles.stepDescription}>{step.description}</p>
            </article>
          ))}
        </div>
        <p className={styles.howItWorksNote}>
          &gt; Below threshold: anonymous. Above: prove KYC in zero-knowledge.
        </p>
      </section>

      <footer className={styles.footer}>
        <span>Built for Sui Overflow 2026 — DeFi &amp; Payments Track</span>
      </footer>
    </main>
  );
}
