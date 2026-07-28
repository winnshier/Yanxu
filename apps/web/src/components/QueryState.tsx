import type { ReactNode } from 'react';
import { Alert, Button, Empty, Skeleton } from 'antd';

interface QueryStateProps {
  loading: boolean;
  error: Error | null;
  empty?: boolean;
  emptyText?: string;
  onRetry?: () => void;
  children: ReactNode;
}

export function QueryState({ loading, error, empty, emptyText = '暂无数据', onRetry, children }: QueryStateProps) {
  if (loading) return <Skeleton active paragraph={{ rows: 5 }} />;
  if (error) return <Alert type="error" showIcon message="加载失败" description={error.message} action={onRetry && <Button onClick={onRetry}>重试</Button>} />;
  if (empty) return <Empty description={emptyText} />;
  return children;
}
