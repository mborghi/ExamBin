'use strict';
var express = require('express'),
    handlers = require('./handlers'),
    models = require('./models'),
    helpers = require('./helpers'),
    custom = require('./custom'),
    utils = require('./utils'),
    spike = require('./spike'),
    features = require('./features'),
    processors = require('./processors'),
    middleware = require('./middleware'),
    metrics = require('./metrics'),
    scripts = require('../scripts.json'),
    Promise = require('rsvp').Promise, // jshint ignore:line
    undefsafe = require('undefsafe'),
    config = require('./config'),
    sendy = require('./addons/sendy'),
    reBin = null; // created when the module is imported

var fs = require('fs');
var pathModule = require('path');
var moduleVote = require('./myjsbin/vote');
var moduleTimer = require('./myjsbin/timer');
//in base of the config language
var languageData = require('./myjsbin/language/italian/variable');



function tag(label) {
  'use strict';
  return function (req, res, next) {
    req[label] = true;
    next();
  };
}

function time(label) {
  return function (req, res, next) {
    res.on('header', function () {
      metrics.timing(label, Date.now() - req.start);
      metrics.timing('request', Date.now() - req.start);
    });
    next();
  };
}

function nextRoute(req, res, next) {
  next('route');
}


module.exports = function (app) {
  'use strict';
  // A sandbox object to contain some specific objects that are commonly used by
  // handlers. In future it would be ideal that each handler only receives the
  // objects that it requires.
  var sandbox = {
    store:   app.store,
    models:  models,
    mailer:  app.mailer,
    helpers: helpers.createHelpers(app)
  };

  // Create handlers for accepting incoming requests.
  var binHandler = new handlers.BinHandler(sandbox);
  var sessionHandler = new handlers.SessionHandler(sandbox);
  var errorHandler = new handlers.ErrorHandler(sandbox);
  var userHandler = new handlers.UserHandler(sandbox);
  var upgradeHandler = handlers.upgrade;
  var adminHandler = handlers.admin;

  var root = app.get('url full');
  binHandler.setStartIndexAutoIncrement();

  reBin = new RegExp(root.replace(/^http.?:/, '') + '/(.*?)/(\\d+)/?');

  function binParamFromReferer(req, res, next) {
    reBin.lastIndex = 0; // reset position

    var r = root;
    if (features('sslForAll', req)) {
      //r = r.replace(/http:/, 'https:');
    }

    // only allow cloning via url if it came from jsbin
    if (req.headers.referer && req.headers.referer.indexOf(r) === 0) {
      var match = req.headers.referer.match(reBin) || [];
      if (match.length) {
        req.params.bin = match[1];
        req.params.rev = match[2];

        return next();
      }
    }

    next('route');
  }

  function secureOutput(req, res, next) {
    // 1. check request is supposed to be on a vanity url
    // 2. if not, then check if the req.headers.host matches security.preview
    // 3. if not, redirect
    var metadata = undefsafe(req, 'bin.metadata');
    var settings = {};
    var ssl = false;
    var url;

    if (req.headers.accept && req.headers.accept.indexOf('text/event-stream') !== -1) {
      // ignore event-stream requests
      return next();
    }

    if (settings) {
      try {
        // TODO why on earth am I expecting JSON???
        settings = typeof metadata.settings === 'string' ? JSON.parse(metadata.settings) : metadata.settings;
        ssl = features('sslForAll', { session: { user: { name: metadata.name, pro: metadata.pro, settings: { ssl: settings.ssl }}}});
      } catch (e) {}
    }

    if (features('sslForAll', req)) {
      return next();
    }

    url = sandbox.helpers.url(req.url, true, ssl);

    if ( (!req.secure && ssl) || // a) request *should* be secure
         (req.secure && !ssl) ) { // b) request is secure and *should not* b
      return res.redirect(url);
    }

    next();
  }

  function redirect(url) {
    return function (req, res) {
      res.redirect(url);
    };
  }

  function shouldNotBeSecure(req, res, next) {
    // otherwise redirect to the http version
    if (req.shouldNotBeSecure) {
      return res.redirect('http://' + req.headers.host.replace(/:.*/, '') + req.url);
    }

    // if the flag isn't present, then skip on
    next();
  }

  function denyframes(req, res, next) {
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  }

  function sameoriginframes(req, res, next) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  }

  function captureRefererForLogin(req, res, next) {
    if (!req.session.user) {
      req.session.referer = req.session.referer || req.url;
    } else {
      delete req.session.referer;
    }
    next();
  }

  // Redirects

  // /about doesn't get hit in production - it goes via nginx to our learn repo
  app.get('/about', redirect('http://jsbin.com/about'));
  app.get(['/issues', '/bugs'], redirect('https://github.com/jsbin/jsbin/issues/'));
  app.get(['/video', '/videos', '/tutorials'], redirect('http://www.youtube.com/playlist?list=PLXmT1r4krsTooRDWOrIu23P3SEZ3luIUq'));


  // Handler Events

  binHandler.on('updated', spike.ping.bind(spike));
  binHandler.on('reload', spike.reload.bind(spike));
  binHandler.on('latest-for-user', spike.updateUserSpikes.bind(spike));
  binHandler.on('new-revision', spike.bumpRevision.bind(spike));

  binHandler.on('render-scripts', spike.appendScripts.bind(spike, app.settings.version));

  // Load the bin from the store when encountered in the url. Also handles the
  // "latest" url action.
  app.param('bin', function (req, res, next) {
    var binurl = req.params.bin.toLowerCase(),
        re = /[^\w\-]/;
    if (re.test(binurl)) {
      return next(404);
    }

    if (app.settings.reserved.indexOf(binurl) !== -1) {
      metrics.increment('bin.validate.reserved');
      return next(404);
    }

    res.on('header', function () {
      var now = Date.now();
      if (req.bin) {
        metrics.timing('request.bin.loaded', now - req.start);
      } else {
        metrics.timing('request.bin.404', now - req.start);
      }
      metrics.timing('request', now - req.start);
    });

    if (req.route.path.slice(-('/source').length) === '/source') {
      req.sourceOnly = true;
    }

    next();
  }, userHandler.updateLastSeen, binHandler.loadBin, function (req, res, next) {
    if (req.bin) {
      app.emit('bin:loaded', req);
    }
    next();
  });

  // track the logged in and logged out numbers
  app.get('*', function (req, res, next) {
    if (req.url !== '/runner') {
      if (req.session.user) {
        metrics.increment('user.logged-in');
      } else {
        metrics.increment('user.logged-out');
      }
    }
    next('route');
  });

  // Note: this goes *above* the SSL route jumping that follows.
  app.get('/', denyframes, time('request.root'), userHandler.loadVanityURL, binHandler.loadBin, secureOutput, binHandler.getBinPreview);

  // Set up the routes.
  app.get(/(?:.*\/(edit|watch|download|source)|^\/$)$/, function (req, res, next) {
    var ssl = features('sslForAll', req);

    if ( (!req.secure && ssl) || // a) request *should* be secure
         (req.secure && !ssl) ) { // b) request is secure and *should not* be
      var url = sandbox.helpers.url(req.url, true, ssl);
      return res.redirect(url);
    }

    next('route');
  });

  // secure the following paths from being iframed, note that it's also applied
  // to full bin output
  app.get('/auth/*', denyframes, nextRoute);
  app.get('/account/*', denyframes, nextRoute);
  app.get('/admin/*', denyframes, nextRoute);

  app.get('/', binHandler.getDefault);
  app.get('/gist/*', shouldNotBeSecure, binHandler.getDefault);
  app.post('/', binHandler.getFromPost);

  // sandbox
  app.get(['/-', '/null'], features.route('sandbox'), tag('sandbox'), binHandler.getDefault);

  // Runner
  app.get('/runner', function (req, res) {
    var statik = sandbox.helpers.urlForStatic(undefined, req.secure);
    res.render('runner', {
      scripts: app.get('is_production') ? false : scripts.runner,
      'static': statik
    });
  });

  app.post('/processor', features.route('processors'), function (req, res) {
    processors.run(req.body.language, req.body).then(function (data) {
      res.send(data);
    }).catch(function (error) {
      console.error(error);
      res.send(500, error.message);
    });
  });

  app.get('/api/:bin/:rev?', binHandler.apiGetBin);
  app.post('/api/save', binHandler.apiCreateBin);
  app.post('/api/:bin/save', binHandler.apiCreateRevision);


  // patch this route to get them back to upgrade
  app.get('/account/upgrade', function (req, res) {
    res.redirect('/upgrade');
  });

  app.get('/account/upgrade/pay', function (req, res, next) {
    if (!req.session.user) {
      req.flash(req.flash.REFERER, req.url);
      req.flash(req.flash.NOTIFICATION, 'Before upgrading to <strong>Pro</strong> you will need to create a free account or log in.');
      return res.redirect('/login');
    }

    next('route');
  });

  // require that all account requests ensure login
  app.get('/account/*', sessionHandler.requiresLoggedIn, nextRoute);
  app.post('/account/*', sessionHandler.requiresLoggedIn, nextRoute);

  function alreadyUpgraded(req, res, next) {
    if (features('pro', req)) {
      return res.redirect('/account/subscription');
    }

    next('route');
  }

  app.get(['/account/upgrade/*', '/account/upgrade'], alreadyUpgraded);
  app.get('/upgrade', features.route('upgradeWithFeatures'), alreadyUpgraded);

  app.get('/account/subscription', features.route('pro'), upgradeHandler.subscription);
  app.post('/account/subscription/cancel', features.route('pro'), upgradeHandler.cancel);

  app.get('/stripe/create-plans', features.route('admin'), upgradeHandler.admin.createPlans);

  app.get('/upgrade', features.route('!upgradeWithFeatures'), upgradeHandler.features);
  app.get('/upgrade', features.route('upgradeWithFeatures'), captureRefererForLogin, upgradeHandler.payment);

  app.post('/upgrade', features.route('upgradeWithFeatures'), sessionHandler.requiresLoggedIn, upgradeHandler.processPayment);

  app.get('/account/upgrade/pay', features.route('!upgradeWithFeatures'), upgradeHandler.payment);
  app.get('/account/upgrade/pay', features.route('upgradeWithFeatures'), redirect('/upgrade'));
  app.post('/account/upgrade/pay', features.route('!upgradeWithFeatures'), upgradeHandler.processPayment);


  // Account settings
  var renderAccountSettings = (function(){
    var pages = ['editor', 'profile', 'delete', 'preferences'];
    var titles = {
      editor: 'Editor settings',
      profile: 'Profile',
      preferences: 'Preferences',
      'delete': 'Delete your account'
    };

    return function renderAccountSettings (req, res) {
      var root = sandbox.helpers.url('', true, req.secure);
      var statik = sandbox.helpers.urlForStatic('', req.secure);
      var referrer = req.get('referer');

      var page = pages.indexOf(req.param('page')) === -1 ? false : req.param('page');

      var addons = [];
      if (!app.get('is_production')) {
        for (var prop in scripts.addons) {
          if (scripts.addons.hasOwnProperty(prop)) {
            addons = addons.concat(scripts.addons[prop]);
          }
        }
      }

      var info = req.flash(req.flash.INFO),
          error = req.flash(req.flash.ERROR),
          notification = req.flash(req.flash.NOTIFICATION);

      var flash = error || notification || info;
      var flashType = '';
      if (info) {flashType = 'info';}
      if (notification) {flashType = 'notification';}
      if (error) {flashType = 'error';}

      if (!page) {
        return res.redirect('back');
      }

      res.render('account/' + page, {
        title: titles[page],
        flash_tip: flash, // jshint ignore:line
        flash_tip_type: flashType, // jshint ignore:line
        token: req.session._csrf,
        layout: 'sub/layout.html',
        referrer: referrer,
        httproot: root.replace('https', 'http'),
        root: root,
        'static': statik,
        user: req.session.user,
        request: req,
        addons: app.get('is_production') ? false : addons
      });
    };
  }());

  if (features('sendy')) {
    app.get('/account/profile', sendy.middleware.setSubscribedOnUser, nextRoute);
  }

  app.get('/account/:page', shouldNotBeSecure, features.route('accountPages'), renderAccountSettings);
  app.get('/account', function(req, res) {
    res.redirect('/account/editor');
  });

  app.post('/account/editor', features.route('accountPages'), function(req, res) {
    if (!req.session || !req.session.user) {
      return res.send(400, 'Please log in');
    }
    var settings = {};
    try {
      settings = JSON.parse(req.body.settings);
    } catch (e) {} // let's ignore for now

    for(var prop in settings) {
      if(settings[prop] === 'true' || settings[prop] === 'false') {
        settings[prop] = settings[prop] === 'true' ? true : false;
      }
    }
    sandbox.models.user.updateSettings(req.session.user.name, settings, function(err) {
      if (err) {
        console.log(err.stack);
        res.send(400, err);
      }
      req.session.user.settings = settings;
      res.json(200, { all: 'ok'});
    });
  });

  app.get('/account/bookmark/vanity', features.route('vanity'), binParamFromReferer, binHandler.loadBin, userHandler.saveVanityURL);
  app.post('/account/bookmark/vanity', features.route('vanity'), function (req, res, next) {
    reBin.lastIndex = 0; // reset position

    // only allow cloning via url if it came from jsbin
    var match = req.body.url.match(reBin) || [];
    if (match.length) {
      req.params.bin = match[1];
      req.params.rev = match[2];
      return next();
    }

    res.send(400, 'You need to be on a bin to publish it as the vanity home page');

  }, binHandler.loadBin, userHandler.saveVanityURL);

  app.get('/account/bookmark/vanity', features.route('vanity'), function (req, res) {
    res.send({});
  });

  // Login/Create account.
  function renderLoginRegister(req, res) {
    var root = sandbox.helpers.url('', true, req.secure);

    if (req.subdomain) {
      root = root.replace('://', '://' + req.subdomain + '.');
    }

    if (req.session.user) {
      return res.redirect(root);
    }

    if (req.query.firsttime) {
      res.flash(req.flash.NOTIFICATION, 'We\'ve <a target="_blank" href="/blog/ssl"><strong>upgraded our login process to use SSL</strong></a>, however, this does mean  you have been logged out today, so please could you log in again below.<br><br><a href="http://github.com/jsbin/jsbin/issues/new" target="_blank">Questions/problems?</a>');
    }

    // TODO: I wish this were simpler, and automatically gave us the next flash
    // message (and perhaps handled the whole thing for us...)
    var info = req.flash(req.flash.INFO),
        error = req.flash(req.flash.ERROR),
        notification = req.flash(req.flash.NOTIFICATION);

    var flash = error || notification || info;
    var production = (req.cookies && req.cookies.debug) ? false : sandbox.helpers.production;

    res.render('register-login', {
      flash: flash,
      token: req.session._csrf,
      layout: 'sub/layout.html',
      referrer: req.flash(req.flash.REFERER) || req.get('referer'),
      root: root,
      'static': sandbox.helpers.urlForStatic('', req.secure),
      show: req.url.indexOf('/register') !== -1 ? 'register' : 'login',
      forgotten: !!req.query.forgotten || !!undefsafe(req, 'body.forgotten'),
      email: req.query.email || undefsafe(req, 'body.email')
    });
  }

  app.get('/login', features.route('sslLogin'), captureRefererForLogin, renderLoginRegister);
  app.get('/register', features.route('sslLogin'), captureRefererForLogin, renderLoginRegister);
  app.post('/login', sessionHandler.checkUserLoggedIn, userHandler.validateLogin, sessionHandler.loginUser, sessionHandler.redirectUserAfterLogin);

  app.post('/account/update', sessionHandler.routeSetHome);


  // TODO /register should take them through to logged in if the details are correct
  app.post('/register', sessionHandler.checkUserLoggedIn, userHandler.validateRegister, sessionHandler.loginUser, sessionHandler.redirectUserAfterLogin);

  // TODO remove once sslLogin feature has landed
  app.get(['/login', '/register'], function (req, res) {
    res.redirect('http://jsbin.com');
  });

  app.get('/logout', function (req, res) {
    if (req.session.user) {
      delete req.session.referer;
      var root = sandbox.helpers.url('', true, req.secure);
      var statik = sandbox.helpers.urlForStatic('', req.secure);

      res.render('account/logout', {
        request: req,
        token: req.session._csrf,
        learn: 'http://learn.jsbin.com/',
        layout: 'sub/layout.html',
        root: root,
        'static': statik,
        user: req.session.user
      });
    } else {
      // you're not welcome!
      res.redirect('/');
    }
  });
  app.post('/logout', sessionHandler.logoutUser);
  app.post('/forgot', sessionHandler.forgotPassword);
  app.get('/forgot', sessionHandler.requestToken);
  app.get('/reset', sessionHandler.resetPassword);

  // Admin
  app.get('/admin', features.route('admin'), adminHandler.renderAdmin);
  app.get('/admin/*', features.route('admin'), nextRoute);
  app.post('/admin/flag-bin', features.route('admin'), adminHandler.flagBin);
  app.post('/admin/flag-user', features.route('admin'), adminHandler.flagUser);
  app.post('/admin/user-verified', features.route('admin'), adminHandler.userVerified);

   // TODO update - this is currently only used for updating the user's profile
   // when outside of the SSL login process.
  app.post('/sethome', sessionHandler.routeSetHome);

  // GitHub auth
  app.get('/auth/github', sessionHandler.github);
  app.get('/auth/github/callback', sessionHandler.githubPassportCallback, sessionHandler.githubCallback);

  // DropBox auth
  app.get('/auth/dropbox', features.route('dropbox'), sessionHandler.dropboxAuth);
  app.get('/auth/dropbox/callback', sessionHandler.dropboxPassportCallback, sessionHandler.dropboxCallback);

  // List (note that the :user param is handled inside the getUserBins)
  app.get('/list/:user', time('request.list.specific'), binHandler.getUserBins);
  app.get('/list', time('request.list'), binHandler.getUserBins);
  app.get('/show/:user', time('request.homepage'), binHandler.getUserBins);
  app.get('/user/:user', time('request.homepage'), binHandler.getUserBins);

  // Quick and easy urls for test - allows me to do /rem/last on my mobile devices
  app.param('username', sessionHandler.loadUser);

  // Save
  app.post('/save', time('request.bin.create'), binHandler.createBin);

  //pagina per il professore
  app.get('/professor', function(req, res) {

        console.log("IP");
        // per recuperare l'ip del chiamante
        var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        console.log(ip);
      var statik = sandbox.helpers.urlForStatic('', req.secure);
      //todo i need to verify this ip to confirm access
//      if (ip === ipProfMachine) {
        if (ip) {
            req.session.professor = true;
            var duration =  moduleTimer.getDurationInMinutes();
            res.render('controlPanelProf', {
                  static: statik,
                  durationExam: duration.exam,
                  durationOverTime: duration.overTime,
                  data: languageData.controlPanelProf
             });
      } else {
            var redirectUrl = statik + "/student";
            res.render('redirectPage', {
                redirectUrl: redirectUrl
            });
        }
  });

    app.get('/professor/correction', function(req, res) {
        console.log("IP");
        // per recuperare l'ip del chiamante
        var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        console.log(ip);
        var statik = sandbox.helpers.urlForStatic('', req.secure);

        //todo i need to verify this ip to confirm access
//      if (ip === ipProfMachine) {
        if (ip) {
            req.session.professor = true;
            var voteWeight = moduleVote.getVoteWeight();
            res.render('correctionPanelProf', {
                static: statik,
                inputWeightHtml : voteWeight.weightStandardHtml,
                inputWeightCss : voteWeight.weightStandardCss,
                inputWeightJavascript : voteWeight.weightStandardJavascript,
                inputWeightMocha : voteWeight.weightMochaFailure,
                inputStartVote : voteWeight.startVote
            });
        } else {
            var redirectUrl = statik + "/student";
            res.render('redirectPage', {
                redirectUrl: redirectUrl
            });
        }
    });

    app.post('/correction/uploadFileCustom', function(req, res) {

        if (req.session.professor) {
            var tmp_path, target_path, config_path, currentCustom_path;
            var dataToAppend;

            if (req.files.fileMochaUpload.name !== '' && req.files.fileMochaUpload.size !== 0) {
                // get the temporary location of the file
                tmp_path = req.files.fileMochaUpload.path;
                // set where the file should actually exists - in this case it is in the "images" directory
                target_path = './test/myjsbin/' + "testExam3.js";
                config_path = './test/myjsbin/' + "headerTestFile.js";
                currentCustom_path = './test/myjsbin/' + "currentCustomValidation.js";
                // move the file from the temporary location to the intended location
                fs.writeFileSync(target_path, '');
                fs.writeFileSync(currentCustom_path, '');

                dataToAppend = fs.readFileSync(config_path).toString();
                fs.appendFileSync(target_path, dataToAppend);
                dataToAppend = fs.readFileSync(tmp_path).toString();
                fs.appendFileSync(currentCustom_path, dataToAppend);

                fs.appendFile(target_path, dataToAppend, function (err) {
                    if (err) throw err;
                    // delete the temporary file, so that the explicitly set temporary upload dir does not get filled with unwanted files
                    fs.unlink(tmp_path, function () {
                        if (err) throw err;
//                        res.send('File uploaded to: ' + target_path + ' - ' + req.files.fileMochaUpload.size + ' bytes');
                        res.send('File validazione custom uploadato');
                    });
                });

            } else {
                res.json({
                    ok: false,
                    messagge: "nessun file selezionato"
                });
            }
        } else {
            res.render("errorPage", {
                serviceIsNotAccessible : true
            });
        }
    });

    app.post('/clearDefaultFile', function(req, res) {
        if (req.session.professor) {
            var target_path_html = './views/' + "default.html";
            var target_path_css = './views/' + "default.css";
            var target_path_js = './views/' + "default.js";
            fs.writeFileSync(target_path_html, '');
            fs.writeFileSync(target_path_css, '');
            fs.writeFileSync(target_path_js, '');

            res.json({
                ok: true,
                message: "testo esami pulito"
            })
        } else {
            res.render("errorPage", {
                serviceIsNotAccessible : true
            });
        }
    });

    /** here arrive the three file that compose the actual exam professor
     * di default, se il prof non inserisce un file vero e proprio;
     * html: template html5
     * javascript: empty file
     * css: empty file
     * */
  app.post('/uploadFileCustom', function(req, res){
    //console.log(req.files);
      if (req.session.professor) {
          var numFile = 3;
          console.log(numFile);
          var fileUploaded = 0;

          if (req.files.fileHtmlUpload.name !== '' && req.files.fileHtmlUpload.size !== 0) {
              // get the temporary location of the file
              var tmp_path_html = req.files.fileHtmlUpload.path;
              // set where the file should actually exists - in this case it is in the "images" directory
              var target_path_html = './views/' + "default.html";
              // move the file from the temporary location to the intended location
              fs.rename(tmp_path_html, target_path_html, function (err) {
                  if (err) throw err;
                  fileUploaded++;
                  if (fileUploaded === numFile) {
                      sendData();
                  }

                  //I think that this is a surplus operation
                  /*// delete the temporary file, so that the explicitly set temporary upload dir does not get filled with unwanted files
                   fs.unlink(tmp_path_html, function(err) {
                   if (err) throw err;
                   //                res.send('File uploaded to: ' + target_path + ' - ' + req.files.fileUploaded.size + ' bytes');

                   });*/

              });
          }
          /*else {
           //se non ho selezionato nessun file dal mio file system
           res.send('Bella zio billy');
           }*/

          if (req.files.fileCssUpload.name !== '' && req.files.fileCssUpload.size !== 0) {
              // get the temporary location of the file
              var tmp_path_css = req.files.fileCssUpload.path;
              // set where the file should actually exists - in this case it is in the "images" directory
              var target_path_css = './views/' + "default.css";
              // move the file from the temporary location to the intended location
              fs.rename(tmp_path_css, target_path_css, function (err) {
                  if (err) throw err;
                  fileUploaded++;
                  if (fileUploaded === numFile) {
                      sendData();
                  }
              });
          }

          if (req.files.fileJavascriptUpload.name !== '' && req.files.fileJavascriptUpload.size !== 0) {
              // get the temporary location of the file
              var tmp_path_js = req.files.fileJavascriptUpload.path;
              // set where the file should actually exists - in this case it is in the "images" directory
              var target_path_js = './views/' + "default.js";
              // move the file from the temporary location to the intended location
              fs.rename(tmp_path_js, target_path_js, function (err) {
                  //TODO, penso che qui dovrei gestire l'eccezione
                  if (err) throw err;
                  fileUploaded++;
                  if (fileUploaded === numFile) {
                      sendData();
                  }
              });
          }
      } else {
          res.render("errorPage", {
              serviceIsNotAccessible : true
          });
      }

      function sendData(){
          console.log("file uploadati");
          res.json({
              ok : true,
              string : 'File Esame Uploadati con successo'
          });
      }
  });

    //pagina per il l'accesso degli studenti
    app.get('/student', binHandler.getStudentLogin);

    //pagina per il l'accesso degli studenti
    app.post('/confirmStudent', function(req, res) {
        console.log(req.body);
        var prefix = req.headers.referer.substr(req.headers.referer.lastIndexOf('/'));

        //with this function I replace all special char for url with trattino ;)
        //maybe potrei far di più con encode uri component e poi guardare i % o ancora meglio sostituirli con il trattino
        function makeValidUrl(inputString) {
            //delete all trattini
            var s = inputString;
            while (s.indexOf("-") !== -1){
                s = s.replace("-","");
            }

            //decode special charset
            s = utils.encodeSpecialChars(s);

            return s;
        }


        req.session.student = {
            name : makeValidUrl(req.body.name),
            surname : makeValidUrl(req.body.surname),
            matricola : req.body.matricola
        };
        console.log(req.session.student);
        //se arrivo dal servizio di login di uno studente ok
        if (prefix === '/student'){
            var root = sandbox.helpers.url('', true, req.secure);
            var statik = sandbox.helpers.urlForStatic('', req.secure);
            res.render('setupPage',{
                static: statik
            });
        } else {
            res.send("MAle male, stai entrando da un prefix non permesso");
        }
    });

    //service that return a json object with the data of the student that make the exam in a determinate date (choose by the professor)
    app.get('/getFinishStudent', binHandler.getFinishStudentsToday);

    app.get('/correction/validateExams', binHandler.getAllSandbox);

    app.get('/correction/getAllExamsDate', binHandler.getAllExamDate);

    app.get('/professor/correction/file', function (req, res, next){
        if (req.session.professor) {
            var tmpPath = __dirname.substr(0, __dirname.length - 3);
            //this istruction do the MAGIC
            var path = tmpPath + 'public' + pathModule.sep + 'myjsbin' + pathModule.sep + 'correction' + pathModule.sep + 'correction.json';
            //var data = fs.readFileSync(path).toString();
            res.sendfile(path);
        } else {
            res.render("errorPage", {
                serviceIsNotAccessible : true
            });
        }
    });

    /*app.get('/examText', function (req, res, next){
        var tmpPath = __dirname.substr(0, __dirname.length - 3);
        //this istruction do the MAGIC
        var path = tmpPath + 'public' + pathModule.sep + 'myjsbin' + pathModule.sep + 'examText' + pathModule.sep + 'examText.pdf';
        res.sendfile(path);
    });

    app.post('/professor/uploadExamTextFile', function(req, res) {

        if (req.session.professor) {
            var tmp_path, target_path;

            if (req.files.textExamFile.name !== '' && req.files.textExamFile.size !== 0) {
                var tmp_path = req.files.textExamFile.path;
                var target_path = './public/myjsbin/examText/' + "examText.pdf";
                fs.rename(tmp_path, target_path, function (err) {
                    if (err) throw err;
                    res.json({
                        ok: true,
                        messagge: "Testo Esame Uploadato con successo"
                    });
                });
            } else {
                res.json({
                    ok: false,
                    messagge: "nessun file selezionato"
                });
            }
        } else {
            res.render("errorPage", {
                serviceIsNotAccessible : true
            });
        }
    });*/

    app.post('/deliveryExam', binHandler.updateBinCompleteExam);

    app.get('/getClockAula', binHandler.getClockClassroom);

    app.get('/finishExam', function (req, res, next){
        res.render('finishPage',null);
    });

    app.get('/professor/correction/exampleCustomValidation', function (req, res, next){
        //control if the access is allowed from this request
        if (req.session.professor) {
            var tmpPath = __dirname.substr(0, __dirname.length - 3);
            //this istruction do the MAGIC
            var path = tmpPath + 'test' + pathModule.sep + 'myjsbin' + pathModule.sep + 'proveTest.js';
            //var data = fs.readFileSync(path).toString();
            res.sendfile(path);
        } else {
            res.render("errorPage", {
                serviceIsNotAccessible : true
            });
        }
    });

    app.get('/professor/correction/currentCustomValidation', function (req, res, next){
        //control if the access is allowed from this request
        if (req.session.professor) {
            var tmpPath = __dirname.substr(0, __dirname.length - 3);
            //this istruction do the MAGIC
            var path = tmpPath + 'test' + pathModule.sep + 'myjsbin' + pathModule.sep + 'currentCustomValidation.js';
            res.sendfile(path);
        }  else {
            res.render("errorPage", {
                serviceIsNotAccessible : true
            });
        }
    });

    app.post('/setClockAula', binHandler.setClockClassroom);

    app.post('/setDataClockAula', binHandler.setDataClockClassromm);

    app.post('/correction/setWeightValidation', binHandler.setVoteWeight);

  // Clone directly via url
  app.get('/clone', time('request.bin.clone'), binParamFromReferer, function (req, res, next) {
    // donkey talk for "create a clone" :(
    req.params.method = 'save,new';
    next();
  }, binHandler.loadBin, function (req, res, next) {
    // TODO remove this middleware and make it easier to clone
    // copy the bin to the body so it looks like it was posted
    req.body = utils.extract(req.bin, 'html', 'css', 'javascript', 'settings');
    req.body.settings = JSON.stringify(req.body.settings);
    next();
  }, binHandler.createRevisionOrClone);


  // FIXME the assetUrl url lookup from username should go via memcache,
  // because doing a mysql query for every image that appears in these bins
  // will start to get silly expensive
  app.get('/:username/assets/*', features.route('assets'), function (req, res) {
    if (req.user.settings && req.user.settings.assetUrl) {
      res.redirect(req.user.settings.assetUrl + req.params[0]);
    } else {
      res.send(404);
    }
  });



  /** Bin based urls **/

  // tag those urls that are the editor view (useful for the 404s)
  app.get(/\/(edit|watch)$/, tag('editor'), nextRoute);

  // check whether a get request has a subdomain, and whether it should be
  // redirected back to the default host for jsbin
  app.get('*', function (req, res, next) {
    new Promise(function (resolve, reject) {
      if (req.subdomain) {
        if (custom[req.subdomain]) {
          // custom domain (like emberjs, etc)
          return resolve();
        } else if (/(embed|edit|watch|download|source)$/i.test(req.url)) {
          return reject('vanity urls not allowed on these urls');
        }
      }

      resolve();
    }).then(function () {
      next('route');
    }).catch(function (reason) {
      console.error(req.headers.host + ' not allowed: ' + reason);
      res.redirect(req.app.get('url full') + req.url);
    });
  });

  // username shortcut routes
  app.get('/:username/last(-:n)?/edit', binHandler.getLatestForUser, binHandler.getBin);
  app.get('/:username/last(-:n)?/watch', binHandler.getLatestForUser, binHandler.live, binHandler.getBin);


  // Edit
  app.get('/:bin/:rev?/edit', binHandler.getBin);
  app.get('/:bin/:rev?/watch', tag('live'), binHandler.getBin);
  app.get('/:bin/:rev?/embed', tag('embed'), binHandler.getBin);

  // don't expose anymore - reporting goes through github
  // app.post('/:bin/:rev?/report', binHandler.report);

  // Use this handler to check for a user creating/claiming their own bin url.
  // We use :url here to prevent loadBin() being called and returning a not
  // found error.
  app.post('/:url/save', time('request.bin.save.claim'), binHandler.claimBin);

  // If the above route fails then it's either a clone or a revision. Which
  // the handler can check in the post body.
  app.post('/:bin/:rev?/save', time('request.bin.update'), binHandler.createRevisionOrClone);
  app.post('/:bin/:rev?/reload', binHandler.reload);

  // delete a bin
  app.post('/:bin/:rev?/delete', time('request.bin.delete'), features.route('delete'), binHandler.delete);

  // Private
  app.post('/:bin/:rev?/private', binHandler.setBinAsPrivate);
  app.post('/:bin/:rev?/public', binHandler.setBinAsPublic);

  // Archive
  app.post('/:bin/:rev/archive', binHandler.archiveBin.bind(null, true));
  // Unarchive
  app.post('/:bin/:rev/unarchive', binHandler.archiveBin.bind(null, false));

  // Download
  app.get('/download', binParamFromReferer, binHandler.loadBin, binHandler.downloadBin);
  app.get('/:bin/:rev?/download', binHandler.downloadBin);


  /**
   * Full output routes
   */
  // Source
  app.all('*', middleware.cors(), nextRoute);
  app.get('/:bin/:rev?/source', time('request.source'), binHandler.getBinSource);

  app.get('/:bin/:rev?.:format(' + Object.keys(processors.mime).join('|') + ')', secureOutput, sameoriginframes, time('request.source'), binHandler.getBinSourceFile);
  app.get('/:bin/:rev?/:format(js)', secureOutput, sameoriginframes, function (req, res) {
    // Redirect legacy /js suffix to the new .js extension.
    res.redirect(301, req.path.replace(/\/js$/, '.js'));
  });

  // Preview
  app.get('/:username/last(-:n)?/:quiet(quiet)?', secureOutput, sameoriginframes, tag('keepLatest'), binHandler.getLatestForUser, spike.getStream, binHandler.getBinPreview);
  app.get('/:bin/:quiet(quiet)?', secureOutput, sameoriginframes, binHandler.testPreviewAllowed, spike.getStream, binHandler.getBinPreview);
  app.get('/:bin/:rev?/:quiet(quiet)?', secureOutput, sameoriginframes, binHandler.testPreviewAllowed, spike.getStream, binHandler.getBinPreview);
  app.get('/:bin/:rev?/stats', tag('stats'), secureOutput, spike.getStream);

  // used for simple testing
  app.get('/test/error/:num', function (req, res, next) {
    next(req.params.num * 1);
  });

  // Handle failed auth requests.
  app.use(sessionHandler.githubCallbackWithError);

  // Catch all
  app.use(errorHandler.notFound);

  // Error handler.
  app.use(errorHandler.httpError);

  // Final connect error handler when in development.
  app.configure('development', function () {
    app.use(express.errorHandler({showStack: true, dumpExceptions: true}));
  });

  // Final connect error handler when in development.
  app.configure('production', function () {
    app.use(errorHandler.uncaughtError);
  });
};
