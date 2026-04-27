/**
 * @format
 * Lazy singleton wrapper for the Kubernetes BatchV1 API client.
 * Loads in-cluster config (uses the SA token mounted at
 * /var/run/secrets/kubernetes.io/serviceaccount/token).
 */
import * as k8s from '@kubernetes/client-node';

let _batchApi: k8s.BatchV1Api | undefined;

export function getBatchApi(): k8s.BatchV1Api {
    if (!_batchApi) {
        const kc = new k8s.KubeConfig();
        kc.loadFromCluster();
        _batchApi = kc.makeApiClient(k8s.BatchV1Api);
    }
    return _batchApi;
}

export function _resetBatchApi(): void { _batchApi = undefined; }
