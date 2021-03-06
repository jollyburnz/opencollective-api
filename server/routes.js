import serverStatus from 'express-server-status';
import GraphHTTP from 'express-graphql';
import curlify from 'request-as-curl';
import multer from 'multer';
import debug from 'debug';
import { ApolloServer } from 'apollo-server-express';
import { formatError } from 'apollo-errors';

import * as connectedAccounts from './controllers/connectedAccounts';
import getDiscoverPage from './controllers/discover';
import * as transactions from './controllers/transactions';
import * as collectives from './controllers/collectives';
import * as RestApi from './graphql/v1/restapi';
import getHomePage from './controllers/homepage';
import uploadImage from './controllers/images';
import * as mw from './controllers/middlewares';
import * as notifications from './controllers/notifications';
import { getPaymentMethods, createPaymentMethod } from './controllers/paymentMethods';
import * as test from './controllers/test';
import * as users from './controllers/users';
import * as applications from './controllers/applications';
import stripeWebhook from './controllers/webhooks';

import * as email from './controllers/services/email';
import syncMeetup from './controllers/services/meetup';

import required from './middleware/required_param';
import ifParam from './middleware/if_param';
import * as aN from './middleware/security/authentication';
import * as auth from './middleware/security/auth';
import errorHandler from './middleware/error_handler';
import * as params from './middleware/params';
import errors from './lib/errors';

import * as paypal from './paymentProviders/paypal/payment';

import sanitizer from './middleware/sanitizer';
import { sanitizeForLogs } from './lib/utils';

import graphqlSchemaV1 from './graphql/v1/schema';
import graphqlSchemaV2 from './graphql/v2/schema';

const upload = multer();

const cacheControlMaxAge = maxAge => {
  maxAge = maxAge || 5;
  return (req, res, next) => {
    res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
    next();
  };
};

/**
 * NotImplemented response.
 */
const NotImplemented = (req, res, next) => next(new errors.NotImplemented('Not implemented yet.'));

export default app => {
  /**
   * Status.
   */
  app.use('/status', serverStatus(app));

  /**
   * Extract GraphQL API Key
   */
  app.use('/graphql/:version/:apiKey?', (req, res, next) => {
    req.apiKey = req.params.apiKey;
    next();
  });

  app.use('*', auth.checkClientApp);

  app.use('*', auth.authorizeClientApp);

  if (process.env.DEBUG) {
    app.use('*', (req, res, next) => {
      const body = sanitizeForLogs(req.body || {});
      debug('operation')(body.operationName, JSON.stringify(body.variables, null));
      if (body.query) {
        const query = body.query;
        debug('params')(query);
        delete body.query;
      }
      debug('params')('req.query', req.query);
      debug('params')('req.body', JSON.stringify(body, null, '  '));
      debug('params')('req.params', req.params);
      debug('headers')('req.headers', req.headers);
      debug('curl')('curl', curlify(req, req.body));
      next();
    });
  }

  /**
   * User reset password or new token flow (no jwt verification)
   */
  app.post('/users/signin', required('user'), users.signin);
  app.post('/users/token', auth.mustBeLoggedIn, users.token);
  app.post('/users/update-token', auth.mustBeLoggedIn, users.updateToken);

  // These two endpoints are used by opencollective-website and might
  // be removed when the new frontend replaces it.
  app.post('/users/new_login_token', required('email'), mw.getOrCreateUser, users.sendNewTokenByEmail);
  app.post('/users/refresh_login_token', aN.authenticateUserByJwtNoExpiry(), users.refreshTokenByEmail);

  /**
   * Moving forward, all requests will try to authenticate the user if there is a JWT token provided
   * (an error will be returned if the JWT token is invalid, if not present it will simply continue)
   */
  app.use('*', aN.authenticateUser); // populate req.remoteUser if JWT token provided in the request

  /**
   * Parameters.
   */
  app.param('uuid', params.uuid);
  app.param('userid', params.userid);
  app.param('collectiveid', params.collectiveid);
  app.param('transactionuuid', params.transactionuuid);
  app.param('paranoidtransactionid', params.paranoidtransactionid);
  app.param('expenseid', params.expenseid);

  /**
   * GraphQL v1
   */
  const graphqlServerV1 = GraphHTTP({
    formatError,
    schema: graphqlSchemaV1,
    pretty: process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'staging',
    graphiql: process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'staging',
  });

  app.use('/graphql/v1', graphqlServerV1);

  /**
   * GraphQL v2
   */
  const graphqlServerV2 = new ApolloServer({
    schema: graphqlSchemaV2,
    introspection: true,
    playground: false,
    // Align with behavior from express-graphql
    context: ({ req }) => {
      return req;
    },
  });

  graphqlServerV2.applyMiddleware({ app, path: '/graphql/v2' });

  /**
   * GraphQL default (v1)
   */
  app.use('/graphql', graphqlServerV1);

  /**
   * Webhooks that should bypass api key check
   */
  app.post('/webhooks/stripe', stripeWebhook); // when it gets a new subscription invoice
  app.post('/webhooks/mailgun', email.webhook); // when receiving an email
  app.get('/connected-accounts/:service/callback', aN.authenticateServiceCallback); // oauth callback

  app.use(sanitizer()); // note: this break /webhooks/mailgun /graphiql

  /**
   * Homepage
   */
  app.get('/homepage', getHomePage); // This query takes 5s to execute!!!

  /**
   * Discover
   */
  app.get('/discover', getDiscoverPage);

  app.get('/fxrate/:fromCurrency/:toCurrency/:date?', transactions.getFxRateController);

  /**
   * Users.
   */
  app.post('/users', required('user'), users.create); // Create a user.
  app.get('/users/exists', required('email'), users.exists); // Checks the existence of a user based on email.
  app.get('/users/:userid', users.show); // Get a user.
  app.put('/users/:userid/paypalemail', auth.mustBeLoggedInAsUser, required('paypalEmail'), users.updatePaypalEmail); // Update a user paypal email.
  app.get('/users/:userid/email', NotImplemented); // Confirm a user's email.

  // TODO: Why is this a PUT and not a GET?
  app.put('/users/:userid/images', required('userData'), users.getSocialMediaAvatars); // Return possible images for a user.

  /**
   * Credit paymentMethod.
   *
   *  Let's assume for now a paymentMethod is linked to a user.
   */
  // delete this route #postmigration, once frontend is updated
  app.get('/users/:userid/cards', auth.mustBeLoggedInAsUser, getPaymentMethods); // Get a user's paymentMethods.

  app.get('/users/:userid/payment-methods', auth.mustBeLoggedInAsUser, getPaymentMethods); // Get a user's paymentMethods.
  app.post('/users/:userid/payment-methods', NotImplemented); // Create a user's paymentMethod.
  app.put('/users/:userid/payment-methods/:paymentMethodid', NotImplemented); // Update a user's paymentMethod.
  app.delete('/users/:userid/payment-methods/:paymentMethodid', NotImplemented); // Delete a user's paymentMethod.

  /**
   * Create a payment method.
   *
   *  Let's assume for now a paymentMethod is linked to a user.
   */
  app.post('/v1/payment-methods', createPaymentMethod);

  /**
   * Collectives.
   */
  app.post(
    '/groups',
    ifParam('flow', 'github'),
    aN.parseJwtNoExpiryCheck,
    aN.checkJwtExpiry,
    required('payload'),
    collectives.createFromGithub,
  ); // Create a collective from a github repo
  app.post('/groups', required('group'), collectives.create); // Create a collective, optionally include `users` with `role` to add them. No need to be authenticated.
  app.get('/groups/tags', collectives.getCollectiveTags); // List all unique tags on all collectives
  app.get('/groups/:collectiveid', collectives.getOne);
  app.get('/groups/:collectiveid/:tierSlug(backers|users)', cacheControlMaxAge(60), collectives.getUsers); // Get collective backers
  app.get(
    '/groups/:collectiveid/:tierSlug(backers|users).csv',
    cacheControlMaxAge(60),
    mw.format('csv'),
    collectives.getUsers,
  );
  app.put('/groups/:collectiveid', auth.canEditCollective, required('group'), collectives.update); // Update a collective.
  app.put('/groups/:collectiveid/settings', auth.canEditCollective, required('group'), collectives.updateSettings); // Update collective settings
  app.delete('/groups/:collectiveid', NotImplemented); // Delete a collective.

  app.get('/groups/:collectiveid/services/meetup/sync', mw.fetchUsers, syncMeetup);

  /**
   * Member.
   *
   *  Relations between a collective and a user.
   */
  app.post('/groups/:collectiveid/users/:userid', auth.canEditCollective, collectives.addUser); // Add a user to a collective.

  /**
   * Transactions (financial).
   */

  // Get transactions of a collective given its slug.
  app.get('/v1/collectives/:collectiveSlug/transactions', RestApi.getLatestTransactions);
  app.get('/v1/collectives/:collectiveSlug/transactions/:IdOrUUID', RestApi.getTransaction);

  // xdamman: Is this route still being used anywhere? If not, we should deprecate this
  app.get('/transactions/:transactionuuid', transactions.getOne); // Get the transaction details

  // xdamman: Is this route still being used anywhere? If not, we should deprecate this
  app.get(
    '/groups/:collectiveid/transactions',
    mw.paginate(),
    mw.sorting({ key: 'createdAt', dir: 'DESC' }),
    collectives.getTransactions,
  ); // Get a group's transactions.

  /**
   * Notifications.
   *
   *  A user can subscribe by email to any type of activity of a Collective.
   */
  app.post('/groups/:collectiveid/activities/:activityType/unsubscribe', notifications.unsubscribe); // Unsubscribe to a collective's activities

  /**
   * Separate route for uploading images to S3
   * TODO: User should be logged in
   */
  app.post('/images', upload.single('file'), uploadImage);

  /**
   * Generic OAuth (ConnectedAccounts)
   */
  app.get('/:slug/connected-accounts', connectedAccounts.list);
  app.get('/connected-accounts/:service(github)', aN.authenticateService); // backward compatibility
  app.get('/connected-accounts/:service(github|twitter|meetup|stripe|paypal)/oauthUrl', aN.authenticateService);
  app.get('/connected-accounts/:service/verify', aN.parseJwtNoExpiryCheck, connectedAccounts.verify);

  // /**
  //  * Paypal Preapproval.
  //  */
  // app.get('/users/:userid/paypal/preapproval', auth.mustBeLoggedInAsUser, paypal.getPreapprovalKey); // Get a user's preapproval key.
  // app.post('/users/:userid/paypal/preapproval/:preapprovalkey', auth.mustBeLoggedInAsUser, paypal.confirmPreapproval); // Confirm a preapproval key.
  // app.get('/users/:userid/paypal/preapproval/:preapprovalkey', auth.mustBeLoggedInAsUser, paypal.getDetails); // Get a preapproval key details.

  /* PayPal Payment Method Helpers */
  app.post('/services/paypal/create-payment', paypal.createPayment);

  /**
   * External services
   * TODO: we need to consolidate all 3rd party services within the /services/* routes
   */
  app.get('/services/email/approve', email.approve);
  app.get('/services/email/unsubscribe/:email/:slug/:type/:token', email.unsubscribe);

  /**
   * Github API - fetch all repositories using the user's access_token
   */
  app.get('/github-repositories', connectedAccounts.fetchAllRepositories);
  app.get('/github/repo', connectedAccounts.getRepo);
  app.get('/github/orgMemberships', connectedAccounts.getOrgMemberships);

  /**
   * Application Management
   */
  app.post('/applications/create', auth.mustBeLoggedIn, applications.create);
  app.get('/applications/:id', auth.mustBeLoggedIn, applications.read);
  app.post('/applications/:id', auth.mustBeLoggedIn, applications.update);
  app.delete('/applications/:id', auth.mustBeLoggedIn, applications.del);

  /**
   * test-api routes
   */
  app.get('/test/loginlink', test.getTestUserLoginUrl);
  app.get('/test/pdf', test.exportPDF);

  /**
   * Override default 404 handler to make sure to obfuscate api_key visible in URL
   */
  app.use((req, res) => res.sendStatus(404));

  /**
   * Error handler.
   */
  app.use(errorHandler);
};
