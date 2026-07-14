/**
 * Veil x contra — confidential payroll on Sui devnet.
 *
 * Executes a real end-to-end confidential-transfer flow against devnet using
 * Mysten's `contra` package (Twisted ElGamal + Bulletproofs, public beta,
 * UNAUDITED), shaped as one of Veil's stated use cases: confidential payroll
 * with auditor oversight.
 *
 *   issuer   — publishes VEIL, registers it as a confidential token, sets an auditor key
 *   employer — wraps VEIL, pays 3 employees in ONE batched confidential transfer
 *   employees— merge their pending deposits; one unwraps back to a public coin
 *   auditor  — recovers each account's viewing key and decrypts every salary
 *   observer — a keyless chain observer: sees sender/receiver/timing, NOT amounts
 *
 * Every number this prints is measured on-chain (gas from tx effects, latency
 * wall-clock). Nothing is estimated.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import {
	ContraInitializer,
	compileMovePackage,
	filterCreated,
	findObject,
	patchMoveToml,
	publishBytecodes,
	signExecuteAndWait,
	type Bytecodes,
} from 'contra-utils/node';
import {
	contra,
	contraContracts,
	ContraAuditor,
	DiscreteLogTable,
	EncryptedAmount,
	G,
	point,
	pointFromBcs,
	randomScalar,
	TokenAccount,
	TransferEventBcs,
} from 'ts-sdk';

/** VEIL has 6 decimals, matching contracts/sources/token.move. */
const ONE_VEIL = 1_000_000n;
/** SUI (MIST) handed to each participant for gas. */
const FUNDING = 200_000_000n;

const SALARIES = [
	{ label: 'employee-a', amount: 5_000n * ONE_VEIL },
	{ label: 'employee-b', amount: 4_200n * ONE_VEIL },
	{ label: 'employee-c', amount: 2_800n * ONE_VEIL },
];
const PAYROLL_TOTAL = SALARIES.reduce((acc, s) => acc + s.amount, 0n);

interface Metric {
	step: string;
	ms: number;
	gasMist: bigint | null;
	digest: string | null;
	note?: string;
}
const metrics: Metric[] = [];

/** Sum a tx's gas from its on-chain effects. Returns null if effects are absent. */
function gasOf(result: any): bigint | null {
	const g = result?.Transaction?.effects?.gasUsed ?? result?.effects?.gasUsed;
	if (!g) return null;
	const n = (v: unknown) => BigInt(v ?? 0);
	return n(g.computationCost) + n(g.storageCost) - n(g.storageRebate);
}

/** Run `fn`, record wall-clock + gas under `step`, and return its result. */
async function measure<T>(step: string, fn: () => Promise<T>, note?: string): Promise<T> {
	const t0 = performance.now();
	const out = await fn();
	const ms = Math.round(performance.now() - t0);
	metrics.push({ step, ms, gasMist: gasOf(out), digest: (out as any)?.digest ?? null, note });
	console.log(`  ✓ ${step} — ${ms}ms${gasOf(out) !== null ? ` — ${gasOf(out)} MIST` : ''}`);
	return out;
}

async function main() {
	console.log('\n═══ Veil × contra — confidential payroll on Sui devnet ═══\n');

	// ── Phase 0: publish contra + VEIL, register the confidential token ──────────
	console.log('Phase 0 — protocol + token setup');
	const contraMoveDir = join(
		import.meta.dirname,
		'..',
		'vendor',
		'confidential-transfers',
		'move',
	);
	const init = await ContraInitializer.init({
		contraMoveDir,
		network: 'devnet',
		log: (m) => console.log(`  · ${m}`),
	});
	const client = init.client;

	// Issuer publishes VEIL (regulated coin: contra's wrap/unwrap consult the DenyList).
	const issuer = Ed25519Keypair.generate();
	const issuerAddr = issuer.getPublicKey().toSuiAddress();
	await init.fund(issuerAddr, 2_000_000_000n);

	const veilTokenDir = join(import.meta.dirname, '..', 'move', 'veil_token');
	const restoreToml = patchMoveToml(veilTokenDir);
	let veilBytecodes: Bytecodes;
	try {
		veilBytecodes = compileMovePackage(veilTokenDir, { env: 'devnet' });
	} finally {
		restoreToml();
	}
	const veilPublish = await publishBytecodes(veilBytecodes, issuer, client);
	const treasuryCapId = findObject(veilPublish.createdObjects, 'TreasuryCap');
	const tokenType = `${veilPublish.packageId}::veil_token::VEIL_TOKEN`;
	console.log(`  · VEIL published: ${tokenType}`);

	// One auditor key — Veil's compliance model has a single designated auditor.
	const auditorSk = randomScalar();
	const auditorPk = G.multiply(auditorSk);

	const regTokenTx = new Transaction();
	const [ct, managementCap] = regTokenTx.add(
		contraContracts.newConfidentialToken({
			package: init.contraPackageId,
			typeArguments: [tokenType],
			arguments: {
				registry: init.tokenRegistryId,
				T: treasuryCapId,
				auditorPublicKeys: regTokenTx.makeMoveVec({
					type: '0x2::group_ops::Element<0x2::ristretto255::G>',
					elements: [point(auditorPk.toBytes())],
				}),
			},
		}),
	);
	regTokenTx.add(
		contraContracts.shareConfidentialToken({
			package: init.contraPackageId,
			typeArguments: [tokenType],
			arguments: { ct },
		}),
	);
	regTokenTx.transferObjects([managementCap], issuerAddr);
	const tokenChanges = await signExecuteAndWait(regTokenTx, issuer, client);
	findObject(filterCreated(tokenChanges), 'ConfidentialToken');
	console.log('  · VEIL registered as a confidential token (auditor version 0, 1 key)');

	// The SDK client extension. The discrete-log table powers BSGS decryption.
	const table = DiscreteLogTable.create(16);
	const packageConfig = {
		packageId: init.contraPackageId,
		accountRegistryId: init.accountRegistryId,
		tokenRegistryId: init.tokenRegistryId,
	};
	const contraClient = client.$extend(contra({ packageConfig, table }));

	async function exec(tx: Transaction, signer: Ed25519Keypair) {
		const result = await contraClient.core.signAndExecuteTransaction({
			transaction: tx,
			signer,
			include: { effects: true, events: true },
		});
		if (result.$kind === 'FailedTransaction') {
			throw new Error(`tx failed: ${JSON.stringify(result.FailedTransaction.effects?.status)}`);
		}
		await contraClient.core.waitForTransaction({ result });
		return result;
	}

	// ── Phase 1: participants ────────────────────────────────────────────────────
	console.log('\nPhase 1 — accounts (employer + 3 employees)');
	const makeParty = (label: string) => {
		const keypair = Ed25519Keypair.generate();
		const address = keypair.getPublicKey().toSuiAddress();
		return {
			label,
			keypair,
			address,
			tokenAccount: new TokenAccount(address, tokenType, packageConfig),
		};
	};
	const employer = makeParty('employer');
	const employees = SALARIES.map((s) => makeParty(s.label));
	const parties = [employer, ...employees];

	// Fund everyone + create/share their Account in one PTB.
	const setupTx = new Transaction();
	for (const p of parties) {
		const [coin] = setupTx.splitCoins(setupTx.gas, [FUNDING]);
		setupTx.transferObjects([coin], p.address);
		const account = setupTx.add(contraClient.contra.newAccount({ owner: p.address }));
		setupTx.add(contraClient.contra.shareAccount({ account }));
	}
	setupTx.setSender(init.address);
	await measure('setup: fund + create 4 accounts (1 PTB)', () => exec(setupTx, init.keypair));

	// Each party registers its own viewing key (must be self-signed).
	await measure('register: 4 token accounts (parallel)', async () => {
		await Promise.all(
			parties.map(async (p) => {
				const tx = new Transaction();
				tx.add(
					await contraClient.contra.register({
						tokenAccount: p.tokenAccount,
						auditorPublicKeys: [auditorPk],
					}),
				);
				tx.setSender(p.address);
				return exec(tx, p.keypair);
			}),
		);
		return null;
	});

	// ── Phase 2: employer funds the payroll (PUBLIC — this is the leak boundary) ─
	console.log('\nPhase 2 — employer wraps the payroll budget (amount is PUBLIC)');
	const mintTx = new Transaction();
	mintTx.moveCall({
		target: '0x2::coin::mint_and_transfer',
		typeArguments: [tokenType],
		arguments: [
			mintTx.object(treasuryCapId),
			mintTx.pure.u64(PAYROLL_TOTAL),
			mintTx.pure.address(employer.address),
		],
	});
	mintTx.setSender(issuerAddr);
	await measure('mint payroll budget to employer', () => exec(mintTx, issuer));

	const coins = await client.getCoins({ owner: employer.address, coinType: tokenType });
	const wrapTx = new Transaction();
	const [wrapCoin] = wrapTx.splitCoins(wrapTx.object(coins.data[0].coinObjectId), [PAYROLL_TOTAL]);
	wrapTx.add(
		contraClient.contra.wrap({ coin: wrapCoin, receiver: employer.address, tokenType }),
	);
	wrapTx.setSender(employer.address);
	await measure(
		`wrap ${PAYROLL_TOTAL / ONE_VEIL} VEIL (public→confidential)`,
		() => exec(wrapTx, employer.keypair),
		'amount visible on chain — privacy boundary',
	);

	const mergeTx = new Transaction();
	mergeTx.add(
		await contraClient.contra.updateBalance({ tokenAccount: employer.tokenAccount, merge: true }),
	);
	mergeTx.setSender(employer.address);
	await measure('merge pending → active balance', () => exec(mergeTx, employer.keypair));

	const employerBal = await contraClient.contra.getBalance(employer.tokenAccount);
	console.log(`  · employer active balance: ${employerBal.balance.amount / ONE_VEIL} VEIL`);

	// ── Phase 3: THE confidential payroll — 3 salaries, ONE tx, amounts hidden ───
	console.log('\nPhase 3 — batched confidential transfer: 3 salaries in 1 tx (amounts HIDDEN)');
	const batchFn = await measure('build batched transfer (client-side proving)', async () =>
		contraClient.contra.transferBatch({
			tokenAccount: employer.tokenAccount,
			recipients: employees.map((e, i) => ({
				receiverAddress: e.address,
				amount: SALARIES[i].amount,
			})),
		}),
	);
	const payrollTx = new Transaction();
	payrollTx.add(batchFn);
	payrollTx.setSender(employer.address);
	const payrollResult = await measure('execute batched payroll on chain', () =>
		exec(payrollTx, employer.keypair),
	);

	// ── Phase 4: what a KEYLESS chain observer can see ───────────────────────────
	console.log('\nPhase 4 — keyless chain observer');
	const transferEventType = `${packageConfig.packageId}::events::TransferEvent<${tokenType}>`;
	const transferEvents = payrollResult.Transaction!.events!.filter(
		(e: any) => e.eventType === transferEventType,
	);
	const decodedEvents = transferEvents.map((e: any) => TransferEventBcs.parse(e.bcs));
	console.log(`  · ${decodedEvents.length} TransferEvents emitted (one per recipient)`);
	for (const ev of decodedEvents) {
		const hasPlaintextAmount = 'amount' in ev && typeof (ev as any).amount !== 'object';
		console.log(
			`    - sender=${ev.sender.slice(0, 10)}… receiver=${ev.receiver.slice(0, 10)}… ` +
				`batch_index=${ev.batch_index} plaintext_amount_field=${hasPlaintextAmount}`,
		);
	}
	console.log(
		'  → observer learns: sender, receiver, timing, recipient count. NOT the amounts.',
	);

	// ── Phase 5: employees receive; one unwraps (amount PUBLIC again) ────────────
	console.log('\nPhase 5 — employees merge; employee-a unwraps to a public coin');
	await measure('3 employees merge pending → active (parallel)', async () => {
		await Promise.all(
			employees.map(async (e) => {
				const tx = new Transaction();
				tx.add(await contraClient.contra.updateBalance({ tokenAccount: e.tokenAccount, merge: true }));
				tx.setSender(e.address);
				return exec(tx, e.keypair);
			}),
		);
		return null;
	});

	for (const [i, e] of employees.entries()) {
		const bal = await contraClient.contra.getBalance(e.tokenAccount);
		const ok = bal.balance.amount === SALARIES[i].amount;
		console.log(
			`  · ${e.label}: ${bal.balance.amount / ONE_VEIL} VEIL ${ok ? '✓' : '✗ MISMATCH'}`,
		);
		if (!ok) throw new Error(`${e.label} balance mismatch`);
	}

	const unwrapAmount = SALARIES[0].amount;
	const unwrapTx = new Transaction();
	const coinOut = unwrapTx.add(
		await contraClient.contra.unwrap({
			tokenAccount: employees[0].tokenAccount,
			amount: unwrapAmount,
			merge: false,
		}),
	);
	unwrapTx.transferObjects([coinOut], employees[0].address);
	unwrapTx.setSender(employees[0].address);
	await measure(
		`unwrap ${unwrapAmount / ONE_VEIL} VEIL (confidential→public)`,
		() => exec(unwrapTx, employees[0].keypair),
		'amount visible on chain — privacy boundary',
	);

	// ── Phase 6: the auditor decrypts every salary ───────────────────────────────
	console.log('\nPhase 6 — auditor recovers viewing keys and decrypts each salary');
	const auditor = new ContraAuditor({
		suiClient: client,
		packageConfig,
		tokenType,
		table,
		auditorKeyForVersion: new Map([[0, { index: 0, privateKey: auditorSk }]]),
	});

	const audited: Array<{ label: string; expected: bigint; decrypted: bigint }> = [];
	for (const [i, ev] of decodedEvents.entries()) {
		const receiverAccount = await auditor.getTokenAccount(ev.receiver);
		const decrypted = receiverAccount.decryptAmount(
			EncryptedAmount.fromBcs(ev.encrypted_amount_receiver),
			table,
		);
		const expected = SALARIES[i].amount;
		audited.push({ label: SALARIES[i].label, expected, decrypted });
		const ok = decrypted === expected;
		console.log(
			`  · ${SALARIES[i].label}: auditor decrypts ${decrypted / ONE_VEIL} VEIL ` +
				`(expected ${expected / ONE_VEIL}) ${ok ? '✓' : '✗ MISMATCH'}`,
		);
		if (!ok) throw new Error(`auditor decryption mismatch for ${SALARIES[i].label}`);

		// The sender can also re-derive its own outgoing amount with no stored secret.
		const senderAccount = await auditor.getTokenAccount(ev.sender);
		const senderView = senderAccount.recoverSentAmount(
			EncryptedAmount.fromBcs(ev.encrypted_amount_receiver),
			pointFromBcs(ev.seed_point),
			ev.batch_index,
			table,
		);
		if (senderView !== expected) throw new Error(`sender recovery mismatch for ${SALARIES[i].label}`);
	}
	console.log('  → auditor sees every amount; sender re-derives its own. Both verified.');

	// ── Results ─────────────────────────────────────────────────────────────────
	console.log('\n═══ Measured results (devnet, real transactions) ═══\n');
	const pad = (s: string, n: number) => s.padEnd(n);
	console.log(`${pad('step', 46)} ${pad('latency', 10)} gas (MIST)`);
	console.log('─'.repeat(75));
	for (const m of metrics) {
		console.log(
			`${pad(m.step, 46)} ${pad(`${m.ms}ms`, 10)} ${m.gasMist !== null ? m.gasMist : '—'}`,
		);
	}

	const totalGas = metrics.reduce((acc, m) => acc + (m.gasMist ?? 0n), 0n);
	console.log('─'.repeat(75));
	console.log(`${pad('TOTAL', 46)} ${pad('', 10)} ${totalGas}`);

	const outDir = join(import.meta.dirname, '..', 'results');
	mkdirSync(outDir, { recursive: true });
	const outFile = join(outDir, `payroll-devnet-${new Date().toISOString().slice(0, 19)}.json`);
	writeFileSync(
		outFile,
		JSON.stringify(
			{
				network: 'devnet',
				contraPackageId: init.contraPackageId,
				tokenType,
				recipients: SALARIES.length,
				payrollTotalVeil: Number(PAYROLL_TOTAL / ONE_VEIL),
				metrics: metrics.map((m) => ({ ...m, gasMist: m.gasMist?.toString() ?? null })),
				totalGasMist: totalGas.toString(),
				audited: audited.map((a) => ({
					label: a.label,
					expected: a.expected.toString(),
					decrypted: a.decrypted.toString(),
				})),
			},
			null,
			2,
		),
	);
	console.log(`\nRaw results → ${outFile}`);
	console.log('\n✅ PoC complete: 3 salaries paid confidentially, auditor verified, all balances match.\n');
}

main().catch((err) => {
	console.error('\n❌ PoC failed:', err);
	process.exit(1);
});
