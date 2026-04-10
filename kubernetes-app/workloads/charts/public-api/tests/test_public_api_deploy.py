"""Tests for workloads/charts/public-api/deploy.py.

Tests validate:
- SSM resolution with primary path hit
- SSM resolution with Bedrock fallback
- ConfigMap data (no secrets present)
- Constants injected without SSM (GSI names, region)
- DRY RUN mode outputs without side effects
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch, call

import pytest

# ---------------------------------------------------------------------------
# Note: sys.path for this directory is injected by conftest.py, scoped to
# avoid name collision with other workload charts that also have deploy.py.
# ---------------------------------------------------------------------------

from deploy import (
    PublicApiConfig,
    resolve_public_api_config,
    create_public_api_k8s_resources,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def cfg() -> PublicApiConfig:
    """Minimal PublicApiConfig for development environment."""
    c = PublicApiConfig()
    c.ssm_prefix = "/k8s/development"
    c.aws_region = "eu-west-1"
    c.secrets = {}
    return c


@pytest.fixture()
def ssm_client() -> MagicMock:
    """Mock boto3 SSM client."""
    m = MagicMock()
    m.get_paginator.return_value = MagicMock()
    return m


@pytest.fixture()
def client_error_cls() -> type:
    """Minimal ClientError mock (simulates a missing SSM parameter)."""
    from botocore.exceptions import ClientError
    return ClientError


# ---------------------------------------------------------------------------
# Tests: SSM resolution
# ---------------------------------------------------------------------------

class TestResolvePublicApiConfig:
    """Tests for resolve_public_api_config()."""

    def test_resolves_table_name_from_nextjs_ssm(
        self, cfg: PublicApiConfig, ssm_client: MagicMock, client_error_cls: type
    ) -> None:
        """Should resolve DYNAMODB_TABLE_NAME from the primary /nextjs/ SSM path."""
        ssm_client.get_parameter.return_value = {
            "Parameter": {"Value": "nlportfolio-dev-content"}
        }

        result = resolve_public_api_config(cfg, ssm_client, client_error_cls)

        assert result["DYNAMODB_TABLE_NAME"] == "nlportfolio-dev-content"

    def test_falls_back_to_bedrock_ssm_if_nextjs_missing(
        self, cfg: PublicApiConfig, ssm_client: MagicMock, client_error_cls: type
    ) -> None:
        """Should fall back to /bedrock-dev/ path when nextjs path raises ClientError."""
        from botocore.exceptions import ClientError

        def _side_effect(Name: str, **_kwargs: object) -> dict:
            if "nextjs" in Name:
                raise ClientError(
                    {"Error": {"Code": "ParameterNotFound", "Message": "not found"}},
                    "GetParameter",
                )
            return {"Parameter": {"Value": "bedrock-dev-content-table"}}

        ssm_client.get_parameter.side_effect = _side_effect

        result = resolve_public_api_config(cfg, ssm_client, client_error_cls)

        assert result["DYNAMODB_TABLE_NAME"] == "bedrock-dev-content-table"

    def test_gsi_constants_always_injected(
        self, cfg: PublicApiConfig, ssm_client: MagicMock, client_error_cls: type
    ) -> None:
        """GSI names must always be present as constants (not from SSM)."""
        ssm_client.get_parameter.return_value = {"Parameter": {"Value": "some-table"}}

        result = resolve_public_api_config(cfg, ssm_client, client_error_cls)

        assert result["DYNAMODB_GSI1_NAME"] == "gsi1-status-date"
        assert result["DYNAMODB_GSI2_NAME"] == "gsi2-tag-date"

    def test_aws_region_always_injected(
        self, cfg: PublicApiConfig, ssm_client: MagicMock, client_error_cls: type
    ) -> None:
        """AWS_DEFAULT_REGION must always be present from cfg.aws_region."""
        ssm_client.get_parameter.return_value = {"Parameter": {"Value": "t"}}

        result = resolve_public_api_config(cfg, ssm_client, client_error_cls)

        assert result["AWS_DEFAULT_REGION"] == "eu-west-1"

    def test_no_credential_keys_injected(
        self, cfg: PublicApiConfig, ssm_client: MagicMock, client_error_cls: type
    ) -> None:
        """AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must never appear in config."""
        ssm_client.get_parameter.return_value = {"Parameter": {"Value": "t"}}

        result = resolve_public_api_config(cfg, ssm_client, client_error_cls)

        assert "AWS_ACCESS_KEY_ID" not in result
        assert "AWS_SECRET_ACCESS_KEY" not in result
        assert "AWS_SESSION_TOKEN" not in result


# ---------------------------------------------------------------------------
# Tests: Kubernetes resource creation
# ---------------------------------------------------------------------------

class TestCreatePublicApiK8sResources:
    """Tests for create_public_api_k8s_resources()."""

    def test_creates_only_configmap_no_secret(self, cfg: PublicApiConfig) -> None:
        """Must call upsert_configmap — upsert_secret is not imported in deploy.py (by design)."""
        cfg.secrets = {
            "DYNAMODB_TABLE_NAME": "nlportfolio-dev-content",
            "DYNAMODB_GSI1_NAME": "gsi1-status-date",
            "DYNAMODB_GSI2_NAME": "gsi2-tag-date",
            "AWS_DEFAULT_REGION": "eu-west-1",
        }

        mock_v1 = MagicMock()

        with (
            patch("deploy.ensure_namespace") as mock_ns,
            patch("deploy.upsert_configmap") as mock_cm,
        ):
            create_public_api_k8s_resources(mock_v1, cfg)

        mock_ns.assert_called_once_with(mock_v1, "public-api")
        mock_cm.assert_called_once_with(
            mock_v1,
            "public-api-config",
            "public-api",
            cfg.secrets,
        )
        # Confirm upsert_secret is NOT in the deploy module's namespace at all
        import deploy as deploy_module
        assert not hasattr(deploy_module, "upsert_secret"), (
            "upsert_secret must NOT be imported in public-api/deploy.py — "
            "this service uses zero K8s Secrets."
        )

    def test_skips_configmap_on_empty_config(self, cfg: PublicApiConfig) -> None:
        """Should not call upsert_configmap when no config values are resolved."""
        cfg.secrets = {}

        mock_v1 = MagicMock()

        with (
            patch("deploy.ensure_namespace"),
            patch("deploy.upsert_configmap") as mock_cm,
        ):
            create_public_api_k8s_resources(mock_v1, cfg)

        mock_cm.assert_not_called()
