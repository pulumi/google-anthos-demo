import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as random from "@pulumi/random";

export class ConfigManagementCluster extends pulumi.ComponentResource {
    public Cluster: gcp.container.Cluster;
    public Provider: k8s.Provider;
    public Kubeconfig: pulumi.Output<any>;

    constructor(name: string,
                opts: pulumi.ComponentResourceOptions = {}) {
        super("examples:google-anthos-config-management:GkeCluster", name, {}, opts);

        // Create ServiceAccount
        const gkeSa = new gcp.serviceAccount.Account(`${name}-gke-sa`, {
            accountId: name,
            displayName: "GKE Security Service Account",
            project: gcp.config.project,
        }, {parent: this})

        // Create IAM Roles
        const serviceAccountIamRoles: string[] = [
            "roles/logging.logWriter",
            "roles/monitoring.metricWriter",
            "roles/monitoring.viewer"
        ]
        let counter = 0;
        for (const iamRoleName of serviceAccountIamRoles) {
            const projectIamMember = new gcp.projects.IAMMember(`${name}-service-account-${counter++}`, {
                project: gcp.config.project,
                member: gkeSa.email.apply(x => "serviceAccount:" + x),
                role: iamRoleName,
            }, {parent: this})
        }

        // Create Project Services
        const projectServices: string[] = [
            "cloudresourcemanager.googleapis.com",
            "container.googleapis.com",
            "compute.googleapis.com",
            "iam.googleapis.com",
            "logging.googleapis.com",
            "monitoring.googleapis.com",
        ]
        for (const projectServiceName of projectServices) {
            const projService = new gcp.projects.Service(`${name}-service-${counter++}`, {
                project: gcp.config.project,
                disableOnDestroy: false,
                service: projectServiceName,
            }, {parent: this})
        }

        // Create UserName for Cluster
        const username = new random.RandomPet(`${name}-username`, {
            length: 1,
        }, {parent: this}).id;

        // Create Password for Cluster
        const password = new random.RandomString(`${name}-password`, {
            length: 20,
            special: true,
        }, {parent: this, additionalSecretOutputs: ["result"]}).result;

        // Find the latest GKE Version
        const masterVersion = gcp.container.getEngineVersions().then(it => it.latestMasterVersion)

        // Build the cluster
        this.Cluster = new gcp.container.Cluster(`${name}`, {
            name: name,
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
                username: username,
                password: password,
            },
        }, {
            customTimeouts: {
                create: "30m",
                update: "30m",
                delete: "30m"
            },
            ignoreChanges: ["initialNodeCount"],
            parent: this
        })

        const nodePool = new gcp.container.NodePool(`${name}-np`, {
            location: gcp.config.region,
            cluster: this.Cluster.name,
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
            dependsOn: [this.Cluster],
            parent: this,
        })

        this.Kubeconfig = pulumi.all([this.Cluster.name, this.Cluster.endpoint, this.Cluster.masterAuth]).apply(([name, endpoint, auth]) => {
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

        this.Provider = new k8s.Provider(`${name}-provider`, {
            kubeconfig: this.Kubeconfig,
        }, {parent: this});
    }


}
