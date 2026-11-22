/**
 * Loading older history pages.
 *
 * The history used to stop after one Horizon page: many operations yield no
 * feed row (trustlines, data entries, deploys), so an active wallet ran out of
 * visible history long before Horizon ran out of operations. Paging is keyed on
 * the paging token of the oldest operation seen, so pages never overlap.
 *
 * Horizon and Soroban RPC are mocked. No network, and addresses come from
 * `Keypair.random()`.
 */

import { Horizon, Keypair, StrKey, rpc } from '@stellar/stellar-sdk';

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: jest.fn() },
    rpc: { ...actual.rpc, Server: jest.fn() },
  };
});

jest.mock('../network', () => ({
  getNetwork: () => ({
    name: 'testnet',
    horizonUrl: 'https://horizon.test.invalid',
    rpcUrl: 'https://rpc.test.invalid',
  }),
}));

jest.mock('../activity', () => ({ getFeePayerAddress: jest.fn() }));

import { getFeePayerAddress } from '../activity';
import { loadHorizonActivity, loadHorizonActivityPage } from '../horizonActivity';

const mockGetFeePayerAddress = getFeePayerAddress as unknown as jest.Mock;
const MockHorizonServer = Horizon.Server as unknown as jest.Mock;
const MockRpcServer = rpc.Server as unknown as jest.Mock;

function randomAccount(): string {
  return Keypair.random().publicKey();
}

type MockBuilder = { limit: jest.Mock; cursor: jest.Mock; call: jest.Mock };

let builder: MockBuilder;
let rpcGetEvents: jest.Mock;

/** One Horizon operation that becomes a received payment row. */
function paymentOp(id: string, pagingToken: string, account: string, other: string): Record<string, unknown> {
  return {
    id,
    paging_token: pagingToken,
    type: 'payment',
    transaction_hash: `hash-${id}`,
    created_at: '2026-01-01T00:00:00Z',
    asset_type: 'native',
    amount: '1.0000000',
    from: other,
    to: account,
  };
}

beforeEach(() => {
  const b = {} as MockBuilder;
  b.limit = jest.fn(() => b);
  b.cursor = jest.fn(() => b);
  b.call = jest.fn();
  builder = b;
  MockHorizonServer.mockImplementation(() => ({
    operations: () => ({ forAccount: () => ({ order: () => b }) }),
  }));

  rpcGetEvents = jest.fn().mockResolvedValue({ events: [] });
  MockRpcServer.mockImplementation(() => ({
    getLatestLedger: jest.fn().mockResolvedValue({ sequence: 5_000_000 }),
    getEvents: rpcGetEvents,
  }));

  mockGetFeePayerAddress.mockReset();
  mockGetFeePayerAddress.mockResolvedValue(null);
});

describe('loadHorizonActivityPage', () => {
  it('returns the paging token of the oldest operation as the cursor', async () => {
    const me = randomAccount();
    const other = randomAccount();
    builder.call.mockResolvedValue({
      records: [
        paymentOp('op-new', 'token-new', me, other),
        paymentOp('op-old', 'token-old', me, other),
      ],
    });

    const page = await loadHorizonActivityPage(me, 100);

    expect(page.records.map((r) => r.id)).toEqual(['op-new', 'op-old']);
    expect(page.nextCursor).toBe('token-old');
    expect(builder.cursor).not.toHaveBeenCalled();
  });

  it('loads the next page from that cursor, and adds no duplicate rows', async () => {
    const me = randomAccount();
    const other = randomAccount();
    builder.call.mockResolvedValueOnce({
      records: [paymentOp('op-new', 'token-new', me, other)],
    });
    const first = await loadHorizonActivityPage(me, 100);
    expect(first.nextCursor).toBe('token-new');

    builder.call.mockResolvedValueOnce({
      records: [paymentOp('op-older', 'token-older', me, other)],
    });
    const second = await loadHorizonActivityPage(me, 100, first.nextCursor!);

    expect(builder.cursor).toHaveBeenCalledWith('token-new');
    expect(second.records.map((r) => r.id)).toEqual(['op-older']);
    expect(second.nextCursor).toBe('token-older');
  });

  it('reports no older page when Horizon returns an empty page', async () => {
    const me = randomAccount();
    builder.call.mockResolvedValue({ records: [] });

    const page = await loadHorizonActivityPage(me, 100, 'token-oldest');

    expect(page.records).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a failed older page so the screen can offer a retry', async () => {
    const me = randomAccount();
    builder.call.mockRejectedValue(new Error('Horizon is down'));

    await expect(loadHorizonActivityPage(me, 100, 'token-old')).rejects.toThrow('Horizon is down');
  });

  it('still degrades to an empty first load when Horizon fails', async () => {
    const me = randomAccount();
    builder.call.mockRejectedValue(new Error('Horizon is down'));

    await expect(loadHorizonActivity(me, 100)).resolves.toEqual([]);
  });

  it('pages a smart wallet from Horizon alone, without rescanning RPC events', async () => {
    const feePayer = randomAccount();
    mockGetFeePayerAddress.mockResolvedValue(feePayer);
    builder.call.mockResolvedValue({ records: [] });

    // A contract address derived from a random keypair: valid, never real.
    const contractAddress = StrKey.encodeContract(
      StrKey.decodeEd25519PublicKey(Keypair.random().publicKey()),
    );

    const page = await loadHorizonActivityPage(contractAddress, 100, 'token-old');

    expect(builder.cursor).toHaveBeenCalledWith('token-old');
    expect(rpcGetEvents).not.toHaveBeenCalled();
    expect(page).toEqual({ records: [], nextCursor: null });
  });
});
