import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as k8s from "@pulumi/kubernetes";

const gkeSa = new gcp.serviceAccount.Account("gke-sa", {
    accountId: "demo-cluster",
    displayName: "GKE Security Service Account",
    project: gcp.config.project,
})

const serviceAccountIamRoles: string[] = [
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer"
]
let counter = 0;
for (const iamRoleName of serviceAccountIamRoles) {
    const projectIamMember = new gcp.projects.IAMMember(`service-account-${counter++}`, {
        project: gcp.config.project,
        member: gkeSa.email.apply(x => "serviceAccount:" + x),
        role: iamRoleName,
    })
}

const projectServices: string[] = [
    "cloudresourcemanager.googleapis.com",
    "container.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
]
for (const projectServiceName of projectServices) {
    const projService = new gcp.projects.Service(`service-${counter++}`, {
        project: gcp.config.project,
        disableOnDestroy: false,
        service: projectServiceName,
    })
}

const masterVersion = gcp.container.getEngineVersions().then(it => it.latestMasterVersion)

const cluster = new gcp.container.Cluster("demo", {
    name: "demo-cluster",
    project: gcp.config.project,
    location: gcp.config.region,

    minMasterVersion: masterVersion,

    loggingService: "logging.googleapis.com/kubernetes",
    monitoringService: "monitoring.googleapis.com/kubernetes",

    removeDefaultNodePool: true,
    initialNodeCount: 1,

    enableLegacyAbac: false,
    enableBinaryAuthorization: true,

    addonsConfig: {
        horizontalPodAutoscaling: {
            disabled: false,
        },
        istioConfig: {
            disabled: false,
            auth: "AUTH_MUTUAL_TLS",
        },
        cloudrunConfig: {
            disabled: true
        }
    },

    enableTpu: false,
    enableIntranodeVisibility: false,
    enableKubernetesAlpha: false,

    verticalPodAutoscaling: {
        enabled: false,
    },
    masterAuth: {
        username: "testUser",
        password: "Password12345678!!",
    },
}, {
    customTimeouts: {
        create: "30m",
        update: "30m",
        delete: "30m"
    },
    ignoreChanges: ["initialNodeCount"],
})

const nodePool = new gcp.container.NodePool("demo-1-np", {
    location: gcp.config.region,
    cluster: cluster.name,
    nodeCount: 1,

    autoscaling: {
        minNodeCount: 1,
        maxNodeCount: 3,
    },

    management: {
        autoRepair: true,
        autoUpgrade: false,
    },

    nodeConfig: {
        machineType: "n1-standard-2",
        diskType: "pd-ssd",
        diskSizeGb: 30,
        imageType: "COS",
        preemptible: false,
        localSsdCount: 0,

        serviceAccount: gkeSa.email,

        oauthScopes: [
            "https://www.googleapis.com/auth/devstorage.read_only",
            "https://www.googleapis.com/auth/logging.write",
            "https://www.googleapis.com/auth/monitoring",
            "https://www.googleapis.com/auth/servicecontrol",
            "https://www.googleapis.com/auth/service.management.readonly",
            "https://www.googleapis.com/auth/trace.append",
        ],

        metadata: {
            "google-compute-enable-virtio-rng": "true",
            "disable-legacy-endpoints": "true"
        }
    }
}, {
    dependsOn: [cluster]
})

export const k8sConfig = pulumi.all([cluster.name, cluster.endpoint, cluster.masterAuth]).apply(([name, endpoint, auth]) => {
    const context = `${gcp.config.project}_${gcp.config.zone}_${name}`;
    return `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${auth.clusterCaCertificate}
    server: https://${endpoint}
  name: ${context}
contexts:
- context:
    cluster: ${context}
    user: ${context}
  name: ${context}
current-context: ${context}
kind: Config
preferences: {}
users:
- name: ${context}
  user:
    auth-provider:
      config:
        cmd-args: config config-helper --format=json
        cmd-path: gcloud
        expiry-key: '{.credential.token_expiry}'
        token-key: '{.credential.access_token}'
      name: gcp
`;
});

const k8sProvider = new k8s.Provider("gkeK8s", {
    kubeconfig: k8sConfig,
});

const configManagementCRD = new k8s.apiextensions.v1beta1.CustomResourceDefinition("config-mgmg-operator-crd", {
    metadata: {
        labels: {
            "controller-tools.k8s.io": "1.0",
        },
        name: "configmanagements.configmanagement.gke.io",
    },
    spec: {
        group: "configmanagement.gke.io",
        names: {
            kind: "ConfigManagement",
            plural: "configmanagements",
        },
        scope: "Cluster",
        versions: [{
            name: "v1",
            served: true,
            storage: true
        }],
        validation: {
            openAPIV3Schema: {
                properties: {
                    "apiVersion": {
                        description: `APIVersion defines the versioned schema of this representation
            of an object. Servers should convert recognized schemas to the latest
            internal value, and may reject unrecognized values. More info: https://git.k8s.io/community/contributors/devel/api-conventions.md#resources`,
                        type: "string"
                    },
                    "kind": {
                        description: `Kind is a string value representing the REST resource this
            object represents. Servers may infer this from the endpoint the client
            submits requests to. Cannot be updated. In CamelCase. More info: https://git.k8s.io/community/contributors/devel/api-conventions.md#types-kinds`,
                        type: "string",
                    },
                    "metadata": {
                        type: "object",
                    },
                    "spec": {
                        properties: {
                            "clusterName": {
                                description: `ClusterName, if defined, sets the name for this cluster.  If
                unset, the cluster is considered to be unnamed, and cannot use ClusterSelectors`,
                                type: "string"
                            },
                            "configConnector": {
                                description: `ConfigConnector deploys the GCP Config Connector components
                as recognized by the "cnrm.cloud.google.com/system" label set to "true"`,
                                properties: {
                                    "enabled": {
                                        description: `Enable or disable the Config Connector.  Default:
                    false.`,
                                        type: "boolean",
                                    },
                                },
                                type: "object",
                            },
                            "git": {
                                description: `Git contains configuration specific to importing policies
                from a Git repo.`,
                                properties: {
                                    "policyDir": {
                                        description: `PolicyDir is the absolute path of the directory that
                    contains the local policy.  Default: the root directory of the
                    repo.`,
                                        type: "string",
                                    },
                                    "proxy": {
                                        description: `Proxy is a struct that contains options for configuring
                    access to the Git repo via a proxy. Only has an effect when secretType
                    is one of ("cookiefile", "none").  Optional.`,
                                        properties: {
                                            "httpProxy": {
                                                description: `HTTPProxy defines a HTTP_PROXY env variable used
                        to access the Git repo.  If both HTTPProxy and HTTPSProxy
                        are specified, HTTPProxy will be ignored. Optional.`,
                                                type: "string"
                                            },
                                            "httpsProxy": {
                                                description: `HTTPSProxy defines a HTTPS_PROXY env variable used
                        to access the Git repo.  If both HTTPProxy and HTTPSProxy
                        are specified, HTTPProxy will be ignored. Optional.`,
                                                type: "string",
                                            },
                                        },
                                        type: "object"
                                    },
                                    "secretType": {
                                        description: `SecretType is the type of secret configured for access
                    to the Git repo. Must be one of ssh, cookiefile, gcenode, token,
                    or none. Required. The validation of this is case-sensitive.`,
                                        pattern: "^(ssh|cookiefile|gcenode|token|none)$",
                                        type: "string",
                                    },
                                    "syncBranch": {
                                        description: `SyncBranch is the branch to sync from.  Default: "master".`,
                                        type: "string",
                                    },
                                    "syncRepo": {
                                        pattern: "^(((https?|git|ssh):\/\/)|git@)",
                                        type: "string",
                                    },
                                    "syncRev": {
                                        description: `SyncRev is the git revision (tag or hash) to check
                    out. Default: HEAD.`,
                                        type: "string"
                                    },
                                    "syncWait": {
                                        description: `SyncWaitSeconds is the time duration in seconds between
                    consecutive syncs.  Default: 15 seconds. Note that SyncWaitSecs
                    is not a time.Duration on purpose. This provides a reminder to
                    developers that customers specify this value using using integers
                    like "3" in their ConfigManagement YAML. However, time.Duration
                    is at a nanosecond granularity, and it''s easy to introduce a
                    bug where it looks like the code is dealing with seconds but its
                    actually nanoseconds (or vice versa).`,
                                        format: "int64",
                                        type: "integer"
                                    },
                                },
                                type: "object",
                            },
                            "hierarchyController": {
                                description: `Hierarchy Controller enables HierarchyController components
                as recognized by the "hierarchycontroller.configmanagement.gke.io"
                label set to "true".`,
                                type: "object",
                                properties: {
                                    "enabled": {
                                        description: `Enable or disable the Hierarchy Controller.  Default:
                    false.`,
                                        type: "boolean",
                                    },
                                },
                            },
                            "policyController": {
                                description: `Policy Controller enables PolicyController components as
                recognized by the "gatekeeper.sh/manifest" label set to "true".`,
                                type: "object",
                                properties: {
                                    "auditIntervalSeconds": {
                                        description: `AuditIntervalSeconds. The number of seconds between
                    audit runs. Defaults to 60 seconds. To disable audit, set this
                    to 0.`,
                                        format: "int64",
                                        type: "integer",
                                    },
                                    "enabled": {
                                        description: `Enable or disable the Policy Controller.  Default: false.`,
                                        type: "boolean",
                                    },
                                    "exemptableNamespaces": {
                                        description: `ExemptableNamespaces. The namespaces in this list are
                    able to have the admission.gatekeeper.sh/ignore label set. When
                    the label is set, Policy Controller will not be called for that
                    namespace or any resources contained in it. \`gatekeeper-system\`
                    is always exempted.`,
                                        items: {
                                            type: "string"
                                        },
                                        type: "array",
                                    },
                                    "referentialRulesEnabled": {
                                        description: `ReferentialRulesEnabled.  If true, Policy Controller
                    will allow \`data.inventory\` references in the contents of ConstraintTemplate
                    Rego.  No effect unless policyController is enabled.  Default:
                    false.`,
                                        type: "boolean",
                                    },
                                    "templateLibraryInstalled": {
                                        description: `TemplateLibraryInstalled.  If true, a set of default
                    ConstraintTemplates will be deployed to the cluster. ConstraintTemplates
                    will not be deployed if this is explicitly set to false or if
                    policyController is not enabled. Default: true.`,
                                        type: "boolean",
                                    },
                                },
                            },
                            "sourceFormat": {
                                description: `SourceFormat specifies how the repository is formatted.
                See documentation for specifics of what these options do.  Must be
                one of hierarchy, unstructured. Optional. Set to hierarchy if not
                specified.  The validation of this is case-sensitive.`,
                                type: "string"
                            },
                        },
                        type: "object",
                    },
                    "status": {
                        type: "object",
                        properties: {
                            "configManagementVersion": {
                                description: `ConfigManagementVersion is the semantic version number
                of the config management system enforced by the currently running
                config management operator.`,
                                type: "string"
                            },
                            "errors": {
                                items: {
                                    type: "string"
                                },
                                type: "array",
                            },
                            "healthy": {
                                type: "boolean",
                            },
                        },
                        required: ["healthy"],
                    },
                },
                required: [
                    "metadata",
                    "spec"
                ],
            }
        }
    },
}, {
    provider: k8sProvider,
    dependsOn: [nodePool]
})

const configManagementClusterRole = new k8s.rbac.v1.ClusterRole("config-mgmt-operator-cluster-role", {
    metadata: {
        labels: {
            "k8s-app": "config-management-operator",
        },
        name: "config-management-operator",
    },
    rules: [{
        apiGroups: ["*"],
        resources: ["*"],
        verbs: ["*"]
    }],
}, {
    provider: k8sProvider,
    dependsOn: [nodePool]
})

const configManagementClusterRoleBinding = new k8s.rbac.v1.ClusterRoleBinding("config-mgmt-operator-cluster-role", {
    metadata: {
        labels: {
            "k8s-app": "config-management-operator",
        },
        name: "config-management-operator",
        namespace: "kube-system"
    },
    roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "config-management-operator",
    },
    subjects: [{
        kind: "ServiceAccount",
        name: "config-management-operator",
        namespace: "kube-system",
    }]
}, {
    provider: k8sProvider,
    dependsOn: [nodePool]
})

const serviceAccount = new k8s.core.v1.ServiceAccount("service-account", {
    metadata: {
        labels: {
            "k8s-app": "config-management-operator"
        },
        name: "config-management-operator",
        namespace: "kube-system"
    }
}, {
    provider: k8sProvider,
    dependsOn: [nodePool]
})

const deployment = new k8s.apps.v1.Deployment("config-mgmt-operator", {
    metadata: {
        labels: {
            "k8s-app": "config-management-operator"
        },
        name: "config-management-operator",
        namespace: "kube-system"
    },
    spec: {
        strategy: {
            type: "Recreate",
            // must be undefined due to 3-way merge, as
            // rollingUpdate added to the resource by default by the APIServer
            rollingUpdate: undefined,
        },
        selector: {
            matchLabels: {
                "k8s-app": "config-management-operator",
                "component": "config-management-operator",
            }
        },
        template: {
            metadata: {
                labels: {
                    "k8s-app": "config-management-operator",
                    "component": "config-management-operator",
                },
            },
            spec: {
                containers: [{
                    command: [
                        "/manager",
                        "--private-registry="
                    ],
                    name: "manager",
                    image: "gcr.io/config-management-release/config-management-operator:20200603183601-op",
                    resources: {
                        requests: {
                            "cpu": "100m",
                            "memory": "20Mi",
                        }
                    },
                }],
                serviceAccountName: serviceAccount.metadata.name
            }
        },
    }
}, {
    provider: k8sProvider,
    dependsOn: [nodePool, configManagementCRD]
})

const cfgMgmtNamespace = new k8s.core.v1.Namespace("cfgmgmt-namespace", {
    metadata: {
        labels: {
            "configmanagement.gke.io/system": "true"
        },
        name: "config-management-system",
    }
}, {
    provider: k8sProvider,
    dependsOn: [nodePool]
})

const configMgmgGitSync = new k8s.apiextensions.CustomResource(
    "my-new-foobar-object",
    {
        apiVersion: "configmanagement.gke.io/v1",
        kind: "ConfigManagement",
        metadata: {
            name: "config-management",
            namespace: "config-management-system",
        },
        spec: {
            clusterName: "demo-cluster",
            git: {
                syncRepo: "https://github.com/stack72/anthos-demo",
                syncBranch: "master",
                secretType: "none",
                policyDir: "."
            },
        }
    }, {
        provider: k8sProvider,
        dependsOn: [configManagementCRD, cfgMgmtNamespace]
    },
);
