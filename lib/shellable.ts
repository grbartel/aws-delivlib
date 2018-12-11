import assets = require('@aws-cdk/assets');
import cbuild = require('@aws-cdk/aws-codebuild');
import cpipeline = require('@aws-cdk/aws-codepipeline');
import cpipelineapi = require('@aws-cdk/aws-codepipeline-api');
import iam = require('@aws-cdk/aws-iam');
import cdk = require('@aws-cdk/cdk');
import fs = require('fs');
import path = require('path');

const S3_BUCKET_ENV = 'SCRIPT_S3_BUCKET';
const S3_KEY_ENV = 'SCRIPT_S3_KEY';

/**
 * Properties used to create a Shellable
 */
export interface ShellableProps {
  /**
   * Directory with the scripts.
   *
   * The whole directory will be uploaded.
   */
  scriptDirectory: string;

  /**
   * Filename of the initial script to start, relative to scriptDirectory.
   */
  entrypoint: string;

  /**
   * Source for the CodeBuild project
   *
   * @default CodePipelineSource
   */
  source?: cbuild.BuildSource;

  /**
   * What platform to us to run the scripts on
   *
   * @default ShellPlatform.LinuxUbuntu
   */
  platform?: ShellPlatform;

  /**
   * Additional environment variables to set.
   *
   * @default No additional environment variables
   */
  environmentVariables?: { [key: string]: cbuild.BuildEnvironmentVariable };

  /**
   * The compute type to use for the build container.
   *
   * Note that not all combinations are available. For example,
   * Windows images cannot be run on ComputeType.Small.
   *
   * @default ComputeType.Medium
   */
  computeType?: cbuild.ComputeType;

  /**
   * The name for the build project.
   *
   * @default a name is generated by CloudFormation.
   */
  buildProjectName?: string;
}

/**
 * A CodeBuild project that runs arbitrary scripts.
 *
 * The scripts to be run are specified by supplying a directory.
 * All files in the directory are uploaded, then the script designated
 * as the entry point is started.
 *
 * The script is executed in the directory where the build project's
 * input is stored. The directory where the script files are stored
 * is in the $SCRIPT_DIR environment variable.
 *
 * Supports both Windows and Linux computes.
 */
export class Shellable extends cdk.Construct {
  public readonly project: cbuild.Project;
  public readonly role?: iam.Role;

  private readonly platform: ShellPlatform;

  constructor(parent: cdk.Construct, id: string, props: ShellableProps) {
    super(parent, id);

    this.platform = props.platform || ShellPlatform.LinuxUbuntu;

    const entrypoint = path.join(props.scriptDirectory, props.entrypoint);
    if (!fs.existsSync(entrypoint)) {
      throw new Error(`Cannot find test entrypoint: ${entrypoint}`);
    }

    const asset = new assets.ZipDirectoryAsset(this, 'ScriptDirectory', {
      path: props.scriptDirectory
    });

    this.project = new cbuild.Project(this, 'Resource', {
      projectName: props.buildProjectName,
      source: props.source || new cbuild.CodePipelineSource(),
      environment: {
        buildImage: this.platform.buildImage,
        computeType: props.computeType || cbuild.ComputeType.Medium,
      },
      environmentVariables: {
        [S3_BUCKET_ENV]: { value: asset.s3BucketName },
        [S3_KEY_ENV]: { value: asset.s3ObjectKey },
        ...props.environmentVariables
      },
      buildSpec: {
        version: '0.2',
        phases: {
          pre_build: { commands: this.platform.prebuildCommands() },
          build: { commands: this.platform.buildCommands(props.entrypoint) },
        }
      }
    });

    this.role = this.project.role;
    asset.grantRead(this.role);
  }

  public addToPipeline(stage: cpipeline.Stage, name: string, inputArtifact: cpipelineapi.Artifact) {
    this.project.addToPipeline(stage, name, { inputArtifact });
  }
}

/**
 * Platform archetype
 */
export enum PlatformType {
  Linux = 'Linux',
  Windows = 'Windows'
}

/**
 * The platform type to run the scripts on
 */
export abstract class ShellPlatform {
  /**
   * Return a default Ubuntu Linux platform
   */
  public static get LinuxUbuntu(): ShellPlatform {
    // Cannot be static member because of initialization order
    return new LinuxPlatform(cbuild.LinuxBuildImage.UBUNTU_14_04_BASE);
  }

  /**
   * Return a default Windows platform
   */
  public static get Windows(): ShellPlatform {
    // Cannot be static member because of initialization order
    return new WindowsPlatform(cbuild.WindowsBuildImage.WIN_SERVER_CORE_2016_BASE);
  }

  constructor(public readonly buildImage: cbuild.IBuildImage) {
  }

  /**
   * Return commands to download the script bundle
   */
  public abstract prebuildCommands(): string[];

  /**
   * Return commands to start the entrypoint script
   */
  public abstract buildCommands(entrypoint: string): string[];

  /**
   * Type of platform
   */
  public abstract get platformType(): PlatformType;
}

/**
 * A Linux Platform
 */
export class LinuxPlatform extends ShellPlatform {
  public readonly platformType = PlatformType.Linux;

  public prebuildCommands(): string[] {
    return [
      // Better echo the location here; if this fails, the error message only contains
      // the unexpanded variables by default. It might fail if you're running an old
      // definition of the CodeBuild project--the permissions will have been changed
      // to only allow downloading the very latest version.
      `echo "Downloading scripts from s3://\${${S3_BUCKET_ENV}}/\${${S3_KEY_ENV}}"`,
      `aws s3 cp s3://\${${S3_BUCKET_ENV}}/\${${S3_KEY_ENV}} /tmp`,
      `mkdir -p /tmp/scriptdir`,
      `unzip /tmp/$(basename \$${S3_KEY_ENV}) -d /tmp/scriptdir`,
    ];
  }

  public buildCommands(entrypoint: string): string[] {
    return [
      'export SCRIPT_DIR=/tmp/scriptdir',
      `echo "Running ${entrypoint}"`,
      `/bin/bash /tmp/scriptdir/${entrypoint}`,
    ];
  }
}

/**
 * A Windows Platform
 */
export class WindowsPlatform extends ShellPlatform {
  public readonly platformType = PlatformType.Windows;

  public prebuildCommands(): string[] {
    return [
      // Would love to do downloading here and executing in the next step,
      // but I don't know how to propagate the value of $TEMPDIR.
      //
      // Punting for someone who knows PowerShell well enough.
    ];
  }

  public buildCommands(entrypoint: string): string[] {
    return [
      `Set-Variable -Name TEMPDIR -Value (New-TemporaryFile).DirectoryName`,
      `aws s3 cp s3://$env:${S3_BUCKET_ENV}/$env:${S3_KEY_ENV} $TEMPDIR\\scripts.zip`,
      'New-Item -ItemType Directory -Path $TEMPDIR\\scriptdir',
      'Expand-Archive -Path $TEMPDIR/scripts.zip -DestinationPath $TEMPDIR\\scriptdir',
      '$env:SCRIPT_DIR = "$TEMPDIR\\scriptdir"',
      `& $TEMPDIR\\scriptdir\\${entrypoint}`
    ];
  }
}
