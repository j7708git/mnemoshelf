import { describe, expect, it } from 'vitest';
import { accountingMatches, runtimeMatches } from './assertions.mjs';

describe('打包驗收判定', () => {
  it('區分實際 WebGPU 成功與同樣請求 WebGPU 的 CPU 故障退回', () => {
    const gpu = { requestedDevice: 'webgpu', device: 'webgpu', loaded: true, webgpuProbe: { status: 'passed' } };
    const fault = { requestedDevice: 'webgpu', device: 'cpu', loaded: true, fallbackReason: { code: 'load-failed' }, webgpuProbe: { status: 'failed', reason: 'load-failed' } };
    expect(runtimeMatches('gpu', gpu)).toBe(true);
    expect(runtimeMatches('gpu', fault)).toBe(false);
    expect(runtimeMatches('fault', fault)).toBe(true);
    expect(runtimeMatches('fault', gpu)).toBe(false);
  });
  it('拒絕空資料庫及 chunk／向量數量不一致', () => {
    expect(accountingMatches(2, 2)).toBe(true);
    expect(accountingMatches(0, 0)).toBe(false);
    expect(accountingMatches(2, 1)).toBe(false);
  });
});
