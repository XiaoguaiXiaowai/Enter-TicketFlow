import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { writeLog } from '../common/logger';
import { getEnv } from '../config/runtime';
import { MetricsService } from './metrics.service';

interface Sample {
  total: number;
  failures5xx: number;
  loginFailures: number;
  readyFailures: number;
}

const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * 轻量告警：按采样间隔计算增量与阈值，命中后输出 level=warn 的结构化告警日志。
 * 生产环境由日志平台按 {type:"alert"} 路由到值班通道。
 */
@Injectable()
export class AlertsService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private previous: Sample | null = null;
  private readonly lastAlertAt = new Map<string, number>();

  constructor(private readonly metrics: MetricsService) {}

  onModuleInit(): void {
    const interval = getEnv().METRICS_INTERVAL_SECONDS * 1000;
    this.timer = setInterval(() => this.evaluate(), interval);
    this.timer.unref();
    this.previous = this.sample();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  evaluate(): void {
    const env = getEnv();
    const intervalSeconds = env.METRICS_INTERVAL_SECONDS;
    const current = this.sample();
    const previous = this.previous ?? current;
    this.previous = current;

    const requests = current.total - previous.total;
    const failures = current.failures5xx - previous.failures5xx;
    if (requests >= 20 && failures / requests > env.ALERT_5XX_RATIO_PERCENT / 100) {
      this.alert('http_5xx_ratio', {
        value: `${((failures / requests) * 100).toFixed(2)}%`,
        threshold: `${env.ALERT_5XX_RATIO_PERCENT}%`,
        windowSeconds: intervalSeconds,
      });
    }

    const loginFailures = current.loginFailures - previous.loginFailures;
    const loginThreshold = Math.max(
      1,
      Math.round((env.ALERT_LOGIN_FAILURE_PER_MINUTE * intervalSeconds) / 60),
    );
    if (loginFailures >= loginThreshold) {
      this.alert('auth_login_failure_rate', {
        value: loginFailures,
        threshold: loginThreshold,
        windowSeconds: intervalSeconds,
      });
    }

    const readyFailures = current.readyFailures - previous.readyFailures;
    if (readyFailures > 0) {
      this.alert('health_ready_failure', { value: readyFailures, windowSeconds: intervalSeconds });
    }

    const outboxBacklog = this.metrics.sumGauges('outbox_pending_events');
    if (outboxBacklog > env.ALERT_OUTBOX_BACKLOG_THRESHOLD) {
      this.alert('outbox_backlog', {
        value: outboxBacklog,
        threshold: env.ALERT_OUTBOX_BACKLOG_THRESHOLD,
      });
    }

    if (this.metrics.gaugeValue('redis_state') === 0) {
      this.alert('redis_degraded', { value: 'degraded' });
    }
  }

  private sample(): Sample {
    return {
      total: this.metrics.sumCounters('http_requests_total'),
      failures5xx: this.metrics.counterValue('http_5xx_total'),
      loginFailures: this.metrics.counterValue('auth_login_failures_total'),
      readyFailures: this.metrics.counterValue('health_ready_failures_total'),
    };
  }

  private alert(name: string, fields: Record<string, unknown>): void {
    const now = Date.now();
    const last = this.lastAlertAt.get(name) ?? 0;
    if (now - last < ALERT_COOLDOWN_MS) {
      return;
    }
    this.lastAlertAt.set(name, now);
    this.metrics.incCounter('alerts_total', { alert: name });
    writeLog('warn', 'alert triggered', {
      type: 'alert',
      alert: name,
      runbook: 'docs/architecture.md',
      ...fields,
    });
  }
}