var config = {
  "couchServerURI": "http://127.0.0.1:5984"
  , "dbName": "altitude"
}

var express = require('express')
  , routes = require('./routes')
  , user = require('./routes/user')
  , http = require('http')
  , path = require('path')
  , util = require('util')
  , fs = require('fs')
  , request = require('request')
  , sqlite3 = require('sqlite3').verbose()


var app = express()

var dbURI = util.format('%s/%s', config.couchServerURI, config.dbName)

app.configure(function(){
  app.set('port', process.env.PORT || 3000)
  app.set('views', __dirname + '/views')
  app.set('view engine', 'jade')
  app.use(express.favicon())
  app.use(express.logger('dev'))
  app.use(express.bodyParser())
  app.use(express.methodOverride())
  app.use(app.router)
  app.use(express.static(path.join(__dirname, 'public')))
})

app.configure('development', function(){
  app.use(express.errorHandler())
})

;(function connectDb() {
  console.log('\nrequest '+config.couchServerURI)

  request(config.couchServerURI, function(e,r,b) {
    var sc = r && r.statusCode

    if (sc != 200) {
      console.log(util.format('callback from request to: %s\n\tstatusCode=%s\n\terror="%s"\n\twait before retry...', config.couchServerURI, sc, e))
      setTimeout(connectDb, 2000)
    } else {
      console.log(util.format('successful request to %s', config.couchServerURI))

      ;(function createDb() {
      console.log(util.format('\nattempt create database: %s', dbURI))
        request.put(dbURI, function(e,r,b) {
          var sc = r && r.statusCode

          if (sc == 201 || sc == 412) {
            console.log('callback from create db request - success or already exists - statusCode=%s', sc)
            updateDesignDocs(startServer)
          } else {
            console.log('callback from create db request - error\n\tstatusCode=%s\n\terror="%s"\n\tbody="%s"\n\twait before retry...', sc, e, b)
            setTimeout(createDb, 2000)
          }
        })
      })()
    }
  })
})()

function updateDesignDocs(callback) {
  console.log('\nupdateDesignDocs()')

  var genViews = {
    _id: '_design/gen-views'
    , views: {
      'user-activity': {
        map: (function(doc) {
          if (doc.type == 'ACTIVITY_USER_CREATION') emit([doc.userId, 0])
          if (doc.type == 'ACTIVITY_ATTEMPT') emit([doc.user, 1])
        }).toString()
      }
      , 'user-ids-by-name': {
        map: (function(doc) {
          if (doc.type == 'ACTIVITY_USER_CREATION') emit(doc.userName, doc.userId)
        }).toString()
      }
      , 'by-type-date': {
        map: (function(doc) {
          var date = null
          switch(doc.type) {
            case "SYNC_DATA":
              date = doc.syncDate
              break
            case "INSTALLATION":
              date = doc.creationDate
              break
            default:
              date = doc.date
          }
          emit([doc.type, date])
        }).toString()
      }
      , 'logged-events-by-event-type-date': {
        map: (function(doc) {
          if (doc.type == 'LOGGED_EVENT') emit([doc.eventType, doc.date])
        }).toString()
      }
    }
  }

  var uri = util.format('%s/%s/%s', config.couchServerURI, config.dbName, genViews._id)
  console.log('update design doc: %s', uri)

  request(uri, function(e,r,b) {
    var sc = r && r.statusCode
    
    if (!~[200,404].indexOf(sc)) {
      console.log('error retrieving design doc: %s', uri)
      return
    }

    if (sc == 200) {
      genViews._rev = JSON.parse(b)._rev
    }

    //var uri = util.format('%s/%s', config.couchServerURI, config.dbName)
    request({
      uri: uri
      , method: 'PUT'
      , headers: { 'Content-Type': 'application/json' }
      , body: JSON.stringify(genViews)
    }, function(e,r,b) {
      var sc = r && r.statusCode
      if (sc != 201) {
        console.log('error updating design doc "_design/gen-views", posting to : %s\n\tstatusCode: %s\n\terror: %s\n\tbody: %s', uri, sc, e, b)
        return
      }
      console.log('successfully updated design doc: %s', uri)
      callback()
    })
  })
}

function startServer() {
  http.createServer(app).listen(app.get('port'), function() {
    console.log("\nExpress server listening on port " + app.get('port'))
  })
}

function checkResponseError(e, r, b, validStatusCodes, uri, req, res) {
  var sc = r && r.statusCode

  if (typeof validStatusCodes == 'number') validStatusCodes = [validStatusCodes]

  if (!r || !~validStatusCodes.indexOf(sc)) {
    sendError(util.format('Couch Response error.\n\t\tDecoded Request URI: %s\n\t\tValid Status Codes: %s\n\t\tResponse Status Code: %s\n\t\tResponse Error: %s\n\t\tResponse Body: %s'
      , decodeURIComponent(uri)
      , JSON.stringify(validStatusCodes)
      , sc || 'NO RESPONSE'
      , e || 'NULL'
      , (b || '').replace(/\s*$/,'')), req, res)
    return true
  }
}

function sendError(e, req, res) {
  console.log('\n%s ERROR at %s\n\t%s\n', (new Date).toString(), req.url, e)
  res.send(400)
}

app.post('/sync', function(req,res) {
  var syncData = req.body
    , installationDoc
    , sqliteDbPath

  var writeActivityToCouch = function writeActivityToCouch(callback) {
    var docs = [syncData]
    
    if (typeof installationDoc._rev == 'undefined' || syncData.userCreations.length) {
      docs.push(installationDoc)
    }

    syncData.userCreations.forEach(function(doc) {
      if (!~installationDoc.users.indexOf(doc.userId)) { // this will only eval false if user creation activity sent twice
        installationDoc.users.push(doc.userId)
      }
      docs.push(doc)
    })
    syncData.attempts.forEach(function(doc) {
      docs.push(doc)
    })
    syncData.loggedEvents.forEach(function(doc) {
      docs.push(doc)
    })

    // write docs to couch
    var uri = util.format('%s/%s', dbURI, '_bulk_docs')
    request({
      uri: uri
      , method: 'POST'
      , headers: { 'Content-Type': 'application/json' }
      , body: JSON.stringify({ docs: docs })
    }, function(e,r,b) {
      if (checkResponseError(e,r,b,201,uri,req,res)) return
      callback()
    })
  }

  var createInstallationStateSqliteDb = function createInstallationStateSqliteDb(usersState, callback) {
    sqliteDbPath = util.format('/tmp/%s', installationDoc._id)

    fs.unlink(sqliteDbPath, function() {
      var db = new sqlite3.Database(sqliteDbPath)
      var usersColDefs =
        [ 'id TEXT PRIMARY KEY ASC'
        , 'name TEXT NOT NULL'
        , 'creation_date REAL'
        , 'last_attempt_date REAL'
        , 'last_attempt_score INTEGER'
        , 'best_attempt_date REAL'
        , 'best_attempt_score INTEGER'
        , 'num_attempts INTEGER'
        , 'average_score REAL' ]
      var usersColNames = usersColDefs.map(function(col) { return col.match(/^\S+/)[0] })

      db.serialize(function() {
        //create Users Table
        db.run(util.format('CREATE TABLE Users (%s)', usersColDefs.join(',')))

        // prepare insert statement
        var userIns = db.prepare(util.format(
          'INSERT INTO Users(%s) VALUES (?%s)'
          , usersColNames.join(',')
          , Array(usersColNames.length).join(',?')))

        // insert each user
        usersState.forEach(function(ur) {
          userIns.run.apply(userIns, usersColNames.map(function(col) { return ur[col] }))
        })

        db.close(callback)
      })
    })
  }

  getInstallationDoc(syncData.installationId, req, res, function(doc) {
    installationDoc = doc

    writeActivityToCouch(function() {
      getUsersState(installationDoc.users, req, res, function(usersState) {
        createInstallationStateSqliteDb(usersState, function() {
          res.sendfile(sqliteDbPath, function(e) {
            fs.unlink(sqliteDbPath)
            //console.log('sent db. e =' , e)
          })
        })
      })
    })
  })
})

app.post('/check-username-available', function(req,res) {
  var name = req.body.name
  getUserIdFromName(name, req, res, function(userId) {
    res.send(userId ? 'no' : 'yes')
  })
})

app.post('/download-user', function(req,res) {
  var name = req.body.name
  var installationId = req.body.installationId

  getUserIdFromName(name, req, res, function(userId) {
    if (!userId) {
      res.send(400)
      return
    }

    var next = function() {
      getUsersState([userId], req, res, function(state) {
        var urSQL = state[0]
        var ur = {
          Id: urSQL.id
          , Name: urSQL.name
          , CreationDate: urSQL.creation_date
          , LastAttempt: null
          , BestAttempt: null
          , NumAttempts: urSQL.num_attempts
          , AverageScore: urSQL.average_score
        }

        if (urSQL.last_attempt_date) {
          ur.LastAttempt = { Date:urSQL.last_attempt_date, Score:urSQL.last_attempt_score }
          ur.BestAttempt = { Date:urSQL.best_attempt_date, Score:urSQL.best_attempt_score }
        }

        res.send(JSON.stringify(ur))
      })
    }

    if (!installationId) {
      next()
    } else {
      getInstallationDoc(installationId, req, res, function(doc) {
        if (!~doc.users.indexOf(userId)) {
          doc.users.push(userId)
        }

        var uri = util.format('%s/%s', dbURI, installationId)
        request({
          uri: uri
          , method: 'PUT'
          , headers: { 'Content-Type': 'application/json' }
          , body: JSON.stringify(doc)
        }, function(e,r,b) {
          if (checkResponseError(e, r, b, 201, uri, req, res)) return
          next()
        })
      })
    }
  })
})

function getUserIdFromName(name, req, res, callback) {
  var uri = util.format('%s/%s/_design/gen-views/_view/user-ids-by-name?key="%s"', config.couchServerURI, config.dbName, name)
  request(uri, function(e,r,b) {
    if (checkResponseError(e,r,b, 200, uri, req, res)) return
    var row = JSON.parse(b).rows[0]
    callback(row && row.value)
  })
}

function getUsersState(userIds, req, res, callback) {
  var keys = []
  userIds.forEach(function(u) {
    keys.push([u,0])
    keys.push([u,1])
  })

  var uri = util.format('%s/_design/gen-views/_view/user-activity?include_docs=true&keys=%s', dbURI, encodeURI(JSON.stringify(keys)))
  request(uri, function(e,r,b) {
    if (checkResponseError(e, r, b, 200, uri, req, res)) return

    var usersState = []
      , ur

    JSON.parse(b).rows.forEach(function(row) {
      var doc = row.doc

      if (doc.type == 'ACTIVITY_USER_CREATION') {
        ur = {
          id: doc.userId
          , name: doc.userName
          , creation_date: doc.date
          , last_attempt_date: null
          , last_attempt_score: null
          , best_attempt_date: null
          , best_attempt_score: null
          , num_attempts: 0
          , average_score: 0
        }
        usersState.push(ur)
      } else if (doc.type == 'ACTIVITY_ATTEMPT') {
        ur.average_score = ((ur.average_score * ur.num_attempts) + doc.score) / ++ur.num_attempts
        if (!ur.last_attempt_date || doc.date > ur.last_attempt_date) {
          ur.last_attempt_date = doc.date
          ur.last_attempt_score = doc.score
        }
        if (!ur.best_attempt_date || doc.score > ur.best_attempt_score) {
          ur.best_attempt_date = doc.date
          ur.best_attempt_score = doc.score
        }
      }
    })

    //console.log(JSON.stringify(usersState,null,2))
    callback(usersState)
  })
}

function getInstallationDoc(installationId, req, res, callback) {
  var uri = util.format('%s/%s', dbURI, installationId)
  request(uri, function(e,r,b) {
    if (checkResponseError(e, r, b, [200,404], uri, req, res)) return

    var doc

    doc = r.statusCode == 200
      ? doc = JSON.parse(b)
      : {
        _id: installationId
        , type: 'INSTALLATION'
        , creationDate: +(new Date) / 1000
        , creationRequestURL: req.url
        , users: []
      }

    callback(doc)
  })
}
