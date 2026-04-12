#!/usr/bin/env python3
"""Local unit tests for admin-api deploy.py.

Run WITHOUT any AWS credentials or cluster access:

    python3 test_deploy_local.py              # all tests
    python3 test_deploy_local.py -v           # verbose
    python3 -m pytest test_deploy_local.py -v  # via pytest

What is tested:
    1. Config defaults and env-var overrides
    2. SSM resolution via env-var bypass (no boto3 needed)
    3. --dry-run mode: prints config and exits cleanly (no K8s calls)
    4. Secret/ConfigMap split: correct keys land in the right bucket
    5. IngressRoute hostname derivation (development vs production)
    6. Error raised when Cognito SSM params are missing
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Path setup — mirror what deploy.py does at runtime
# ---------------------------------------------------------------------------
_REPO_ROOT = Path(__file__).resolve().parents[3]  # cdk-monitoring/
_BOOTSTRAP_DIR = str(_REPO_ROOT / "kubernetes-app" / "k8s-bootstrap")
if _BOOTSTRAP_DIR not in sys.path:
    sys.path.insert(0, _BOOTSTRAP_DIR)

# Now import the module under test
sys.path.insert(0, str(Path(__file__).parent))
import deploy as admin_deploy  # noqa: E402  (after sys.path setup)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _full_env(overrides: dict[str, str] | None = None) -> dict[str, str]:
    """Build a complete set of env-var overrides that bypass all AWS calls."""
    base = {
        # SSM resolution bypassed via deploy_helpers/ssm.py env-override logic
        "COGNITO_USER_POOL_ID": "eu-west-1_TestPool",
        "COGNITO_CLIENT_ID": "test-client-id",
        "COGNITO_ISSUER_URL": "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_TestPool",
        # Bedrock infra refs
        "DYNAMODB_TABLE_NAME": "ai-content-table-dev",
        "ASSETS_BUCKET_NAME": "assets-bucket-dev",
        "PUBLISH_LAMBDA_ARN": "arn:aws:lambda:eu-west-1:123456789:function:publish-dev",
        "ARTICLE_TRIGGER_ARN": "arn:aws:lambda:eu-west-1:123456789:function:trigger-dev",
        "STRATEGIST_TRIGGER_ARN": "arn:aws:lambda:eu-west-1:123456789:function:strategist-trigger-dev",
        "STRATEGIST_TABLE_NAME": "strategist-table-dev",
        # Config
        "SSM_PREFIX": "/k8s/development",
        "AWS_REGION": "eu-west-1",
        "KUBECONFIG": "/dev/null",         # prevents real kubectl lookups
        "MANIFESTS_DIR": "/tmp/admin-api-test",
    }
    if overrides:
        base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# A minimal fake ssm_client that returns env-var overrides via get_parameter.
# Used when we explicitly want to exercise the boto3 call path.
# ---------------------------------------------------------------------------

def _fake_ssm_client(param_map: dict[str, str]) -> MagicMock:
    """Return a mock boto3 SSM client backed by param_map."""
    from botocore.exceptions import ClientError  # lazy import — may not be installed

    client = MagicMock()

    def _get_parameter(Name: str, WithDecryption: bool = False) -> dict:  # noqa: N803
        if Name in param_map:
            return {"Parameter": {"Value": param_map[Name]}}
        error_response = {"Error": {"Code": "ParameterNotFound", "Message": "not found"}}
        raise ClientError(error_response, "GetParameter")

    client.get_parameter.side_effect = _get_parameter
    return client


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestAdminApiConfig(unittest.TestCase):
    """Config dataclass defaults and env-var overrides."""

    def setUp(self) -> None:
        """Ensure no override keys pollute between tests."""
        os.environ.pop("FRONTEND_SSM_PREFIX", None)

    def tearDown(self) -> None:
        """Restore environment state after each test."""
        os.environ.pop("FRONTEND_SSM_PREFIX", None)

    def test_defaults(self) -> None:
        with patch.dict(os.environ, {"SSM_PREFIX": "/k8s/development"}, clear=False):
            cfg = admin_deploy.AdminApiConfig()
            self.assertEqual(cfg.namespace, "admin-api")
            self.assertEqual(cfg.aws_region, "eu-west-1")

    def test_frontend_ssm_prefix_derived(self) -> None:
        # property reads os.getenv live — assert INSIDE the patch context
        with patch.dict(os.environ, {"SSM_PREFIX": "/k8s/development"}, clear=False):
            cfg = admin_deploy.AdminApiConfig()
            self.assertEqual(cfg.frontend_ssm_prefix, "/nextjs/development")

    def test_frontend_ssm_prefix_override(self) -> None:
        env = {"SSM_PREFIX": "/k8s/development", "FRONTEND_SSM_PREFIX": "/nextjs/staging"}
        with patch.dict(os.environ, env, clear=False):
            cfg = admin_deploy.AdminApiConfig()
            self.assertEqual(cfg.frontend_ssm_prefix, "/nextjs/staging")

    def test_short_env_development(self) -> None:
        with patch.dict(os.environ, {"SSM_PREFIX": "/k8s/development"}, clear=False):
            cfg = admin_deploy.AdminApiConfig()
            self.assertEqual(cfg.short_env, "dev")

    def test_short_env_production(self) -> None:
        with patch.dict(os.environ, {"SSM_PREFIX": "/k8s/production"}, clear=False):
            cfg = admin_deploy.AdminApiConfig()
            self.assertEqual(cfg.short_env, "prd")


class TestSsmResolutionViaEnvOverride(unittest.TestCase):
    """SSM resolution uses env-var shortcuts — no boto3 required."""

    def _resolve(self, env: dict[str, str]) -> dict[str, str]:
        from deploy_helpers.ssm import resolve_secrets

        class _NeverCalled:
            def get_parameter(self, *_a: object, **_kw: object) -> None:
                raise AssertionError("boto3 SSM should not be called when env overrides exist")

        with patch.dict(os.environ, env, clear=False):
            cfg = admin_deploy.AdminApiConfig()
            return resolve_secrets(
                _NeverCalled(),
                cfg.frontend_ssm_prefix,
                admin_deploy._COGNITO_SSM_MAP,
            )

    def test_cognito_resolved_from_env(self) -> None:
        env = _full_env()
        result = self._resolve(env)
        self.assertEqual(result["COGNITO_USER_POOL_ID"], "eu-west-1_TestPool")
        self.assertEqual(result["COGNITO_CLIENT_ID"], "test-client-id")
        self.assertIn("COGNITO_ISSUER_URL", result)


class TestSecretConfigMapSplit(unittest.TestCase):
    """Verify keys land in the right bucket (Secret vs ConfigMap)."""

    def _build_cfg(self) -> admin_deploy.AdminApiConfig:
        with patch.dict(os.environ, _full_env(), clear=False):
            cfg = admin_deploy.AdminApiConfig()
            # Simulate what resolve_public_api_config returns
            cfg.secrets = {
                "COGNITO_USER_POOL_ID": "eu-west-1_TestPool",
                "COGNITO_CLIENT_ID": "test-client-id",
                "COGNITO_ISSUER_URL": "https://idp.example.com",
                "DYNAMODB_TABLE_NAME": "ai-content-table-dev",
                "ASSETS_BUCKET_NAME": "assets-dev",
                "PUBLISH_LAMBDA_ARN": "arn:aws:lambda:::func",
                "ARTICLE_TRIGGER_ARN": "arn:aws:lambda:::func2",
                "STRATEGIST_TRIGGER_ARN": "arn:aws:lambda:::func3",
                "STRATEGIST_TABLE_NAME": "strat-dev",
                "DYNAMODB_GSI1_NAME": "gsi1-status-date",
                "DYNAMODB_GSI2_NAME": "gsi2-tag-date",
                "SSM_BEDROCK_PREFIX": "/bedrock-dev",
                "AWS_DEFAULT_REGION": "eu-west-1",
            }
        return cfg

    def test_secret_keys_only_cognito(self) -> None:
        cfg = self._build_cfg()
        secret_data = {k: cfg.secrets[k] for k in admin_deploy._SECRET_KEYS if k in cfg.secrets}
        self.assertSetEqual(set(secret_data.keys()), {
            "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "COGNITO_ISSUER_URL",
        })

    def test_config_map_has_no_cognito(self) -> None:
        cfg = self._build_cfg()
        config_data = {k: cfg.secrets[k] for k in admin_deploy._CONFIG_KEYS if k in cfg.secrets}
        for cognito_key in admin_deploy._SECRET_KEYS:
            self.assertNotIn(cognito_key, config_data)

    def test_config_map_has_dynamo(self) -> None:
        cfg = self._build_cfg()
        config_data = {k: cfg.secrets[k] for k in admin_deploy._CONFIG_KEYS if k in cfg.secrets}
        self.assertIn("DYNAMODB_TABLE_NAME", config_data)
        self.assertIn("ASSETS_BUCKET_NAME", config_data)


class TestDryRun(unittest.TestCase):
    """--dry-run prints config and exits without touching K8s or SSM (live)."""

    def test_dry_run_exits_cleanly(self) -> None:
        # Patch the lazy boto3 loader and SSM resolution — dry-run path never
        # touches K8s so no need to mock it.
        mock_secrets = {
            "COGNITO_USER_POOL_ID": "pool-id",
            "COGNITO_CLIENT_ID": "client-id",
            "COGNITO_ISSUER_URL": "https://idp.example.com",
            "DYNAMODB_TABLE_NAME": "table-dev",
            "ASSETS_BUCKET_NAME": "bucket-dev",
            "PUBLISH_LAMBDA_ARN": "arn:aws:lambda:::func1",
            "ARTICLE_TRIGGER_ARN": "arn:aws:lambda:::func2",
            "STRATEGIST_TRIGGER_ARN": "arn:aws:lambda:::func3",
            "STRATEGIST_TABLE_NAME": "strat-dev",
        }

        env = _full_env()

        with patch.dict(os.environ, env, clear=False), \
             patch("sys.argv", ["deploy.py", "--dry-run"]), \
             patch.object(
                 admin_deploy, "_load_boto3",
                 return_value=(MagicMock(), MagicMock()),
             ), \
             patch.object(
                 admin_deploy, "resolve_public_api_config",
                 return_value=mock_secrets,
             ):
            # Should return cleanly with no exception
            admin_deploy.main()


class TestIngressRouteHostname(unittest.TestCase):
    """Hostname derivation for the Traefik IngressRoute."""

    def _hostname(self, env_name: str) -> str:
        with patch.dict(os.environ, {"SSM_PREFIX": f"/k8s/{env_name}"}, clear=False):
            cfg = admin_deploy.AdminApiConfig()
        return "nelsonlamounier.com" if cfg.environment_name == "production" \
            else f"{cfg.environment_name}.nelsonlamounier.com"

    def test_development_hostname(self) -> None:
        self.assertEqual(self._hostname("development"), "development.nelsonlamounier.com")

    def test_production_hostname(self) -> None:
        self.assertEqual(self._hostname("production"), "nelsonlamounier.com")


class TestMissingCognitoRaisesError(unittest.TestCase):
    """create_public_api_k8s_resources must raise if no Cognito values resolved."""

    def test_raises_when_no_cognito(self) -> None:
        with patch.dict(os.environ, _full_env(), clear=False):
            cfg = admin_deploy.AdminApiConfig()
        cfg.secrets = {}  # nothing resolved

        mock_v1 = MagicMock()

        # Patch ensure_namespace so it doesn't attempt real kubectl calls
        with patch.object(admin_deploy, "ensure_namespace"):
            with self.assertRaises(RuntimeError) as ctx:
                admin_deploy.create_public_api_k8s_resources(mock_v1, cfg)

        self.assertIn("admin-api-secrets", str(ctx.exception))
        self.assertIn("Cognito", str(ctx.exception))

if __name__ == "__main__":
    unittest.main(verbosity=2)
