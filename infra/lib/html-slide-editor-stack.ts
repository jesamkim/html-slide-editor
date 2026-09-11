import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export interface HtmlSlideEditorStackProps extends StackProps {
  hostedUiPrefix: string;
  siteAssetDir: string;
}

export class HtmlSlideEditorStack extends Stack {
  constructor(scope: Construct, id: string, props: HtmlSlideEditorStackProps) {
    super(scope, id, props);

    const hostedUiDomain = `${props.hostedUiPrefix}.auth.${this.region}.amazoncognito.com`;

    // Static assets. Never public: CloudFront reaches this through OAC only.
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: 'HTML Slide Editor static site',
      defaultRootObject: 'index.html',
      // CloudFront ignores this while the distribution serves the default
      // *.cloudfront.net certificate, because it pins that certificate's security
      // policy itself and drops the property from the template. The line stays so
      // the floor applies the moment a custom domain and ACM certificate arrive.
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // A single-page app serves its own routes, so a missing key is still index.html.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });

    const siteUrl = `https://${distribution.distributionDomainName}/`;

    const userPool = new cognito.UserPool(this, 'UserPool', {
      // An administrator creates users; there is no public registration.
      selfSignUpEnabled: false,
      deletionProtection: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(7),
      },
      // LITE keeps threat protection off, which bills per monthly active user.
      featurePlan: cognito.FeaturePlan.LITE,
      // Destroying the stack must never take the operator's login with it.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const userPoolDomain = userPool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix: props.hostedUiPrefix },
    });

    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: 'html-slide-editor-web',
      // A browser cannot keep a secret, so this client is public.
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [siteUrl],
        logoutUrls: [siteUrl],
      },
      // The product asks for a 24 hour session that the client refreshes silently.
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(1),
    });

    const deployment = new s3deploy.BucketDeployment(this, 'SiteDeployment', {
      destinationBucket: siteBucket,
      sources: [
        s3deploy.Source.asset(props.siteAssetDir),
        // Fixed contract with the application code: exactly these five keys.
        s3deploy.Source.jsonData('auth-config.json', {
          region: this.region,
          userPoolId: userPool.userPoolId,
          clientId: userPoolClient.userPoolClientId,
          hostedUiDomain,
          redirectUri: siteUrl,
        }),
      ],
      distribution,
      distributionPaths: ['/*'],
    });

    // auth-config.json names the Hosted UI domain, so the domain must exist first.
    deployment.node.addDependency(userPoolDomain);

    new CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });

    new CfnOutput(this, 'SiteUrl', {
      value: siteUrl,
      description: 'Public HTTPS URL of the editor',
    });

    new CfnOutput(this, 'SiteBucketName', {
      value: siteBucket.bucketName,
      description: 'S3 bucket holding the built static assets',
    });

    new CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito user pool id',
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito app client id used by the browser',
    });

    new CfnOutput(this, 'HostedUiDomain', {
      value: hostedUiDomain,
      description: 'Cognito Hosted UI domain',
    });
  }
}
