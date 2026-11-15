import { Injectable } from '@nestjs/common';

export type MetricLabels = Record<string, string>;

interface HistogramSeries {
  buckets: number[];
  counts: number[];
  sum: number;
  total: number;
}

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 200, 300, 500, 1000, 2000, 5000];

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function serializeLabels(labels: MetricLabels): string {
  const names = Object.keys(labels).sort();
  if (names.length === 0) {
    return '';
  }
  const body = names.map((name) => `${name}="${escapeLabelValue(labels[name] ?? '')}"`).join(',');
  return `{${body}}`;
}

function seriesKey(labels: MetricLabels): string {
  return serializeLabels(labels);
}

/**
 * 进程内指标注册表：只保留计数器、仪表与直方图，输出 Prometheus 文本格式。
 * 指标基数由调用方控制（route 使用路由模板而非原始 URL）。
 */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly gauges = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, HistogramSeries>>();

  incCounter(name: string, labels: MetricLabels = {}, value = 1): void {
    const series = this.counters.get(name) ?? new Map<string, number>();
    const key = seriesKey(labels);
    series.set(key, (series.get(key) ?? 0) + value);
    this.counters.set(name, series);
  }

  setGauge(name: string, labels: MetricLabels, value: number): void {
    const series = this.gauges.get(name) ?? new Map<string, number>();
    series.set(seriesKey(labels), value);
    this.gauges.set(name, series);
  }

  observeHistogram(name: string, labels: MetricLabels, value: number): void {
    const buckets = DEFAULT_BUCKETS;
    const bySeries = this.histograms.get(name) ?? new Map<string, HistogramSeries>();
    const key = seriesKey(labels);
    const current = bySeries.get(key) ?? {
      buckets,
      counts: buckets.map(() => 0),
      sum: 0,
      total: 0,
    };
    current.sum += value;
    current.total += 1;
    // 只落在第一个满足 value <= 上限的桶上，导出时再做累计，避免重复计数。
    const index = buckets.findIndex((bucket) => value <= bucket);
    if (index >= 0) {
      current.counts[index] = (current.counts[index] ?? 0) + 1;
    }
    bySeries.set(key, current);
    this.histograms.set(name, bySeries);
  }

  counterValue(name: string, labels: MetricLabels = {}): number {
    return this.counters.get(name)?.get(seriesKey(labels)) ?? 0;
  }

  gaugeValue(name: string, labels: MetricLabels = {}): number {
    return this.gauges.get(name)?.get(seriesKey(labels)) ?? 0;
  }

  sumCounters(name: string): number {
    let total = 0;
    for (const value of this.counters.get(name)?.values() ?? []) {
      total += value;
    }
    return total;
  }

  sumGauges(name: string): number {
    let total = 0;
    for (const value of this.gauges.get(name)?.values() ?? []) {
      total += value;
    }
    return total;
  }

  render(): string {
    const lines: string[] = [];

    for (const name of [...this.counters.keys()].sort()) {
      lines.push(`# TYPE ${name} counter`);
      for (const [labels, value] of this.counters.get(name) ?? []) {
        lines.push(`${name}${labels} ${value}`);
      }
    }

    for (const name of [...this.gauges.keys()].sort()) {
      lines.push(`# TYPE ${name} gauge`);
      for (const [labels, value] of this.gauges.get(name) ?? []) {
        lines.push(`${name}${labels} ${value}`);
      }
    }

    for (const name of [...this.histograms.keys()].sort()) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [labels, series] of this.histograms.get(name) ?? []) {
        let cumulative = 0;
        for (let index = 0; index < series.buckets.length; index += 1) {
          cumulative += series.counts[index] ?? 0;
          const bucketLabels = `${labels === '' ? '{' : `${labels.slice(0, -1)},`}le="${
            series.buckets[index]
          }"}`;
          lines.push(`${name}_bucket${bucketLabels} ${cumulative}`);
        }
        const infLabels = `${labels === '' ? '{' : `${labels.slice(0, -1)},`}le="+Inf"}`;
        lines.push(`${name}_bucket${infLabels} ${series.total}`);
        lines.push(`${name}_sum${labels} ${series.sum}`);
        lines.push(`${name}_count${labels} ${series.total}`);
      }
    }

    return `${lines.join('\n')}\n`;
  }
}