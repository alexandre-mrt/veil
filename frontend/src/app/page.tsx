import Link from "next/link";
import styles from "./page.module.css";

const FEATURES = [
  {
    title: "Anonymous Transfers",
    description: "Send tokens without revealing amounts or identity",
    accent: "var(--accent)",
  },
  {
    title: "Cumulative Proofs",
    description: "Track spending across an epoch without leaking individual transactions",
    accent: "var(--accent)",
  },
  {
    title: "Tiered Compliance",
    description: "KYC kicks in only above the threshold — privacy by default",
    accent: "var(--accent)",
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

      <footer className={styles.footer}>
        <span>Built for Sui Overflow 2026 — DeFi &amp; Payments Track</span>
      </footer>
    </main>
  );
}
