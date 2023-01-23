/// !-----------------------------------------------------------------------------------------------------------
/// |
//  |  `digest-fetch` is a wrapper of `node-fetch` or `fetch` to provide http digest authentication boostraping.
//  |
/// !-----------------------------------------------------------------------------------------------------------

const canRequire = typeof require == 'function'
//@ts-ignore: 2454
//fetch: (input: RequestInfo | URL, init?: RequestInit | undefined) => Promise<Response>
//node-fetch: (url: RequestInfo, init?: RequestInit | undefined) => Promise<Response>
if (typeof fetch !== 'function' && canRequire)
  var fetch:
    | ((
        input: RequestInfo | URL,
        init?: RequestInit | undefined
      ) => Promise<Response>)
    | ((
        url: RequestInfo,
        init?: RequestInit | undefined
      ) => Promise<Response>) = require('node-fetch')

import md5 from 'md5'
import { sha256 } from 'js-sha256'
import { sha512_256 } from 'js-sha512'
import base64 from 'base-64'

const supported_algorithms = [
  'MD5',
  'MD5-sess',
  'SHA-256',
  'SHA-256-sess',
  'SHA-512-256',
  'SHA-512-256-sess',
]

const parse = (raw: string, field: string, trim = true) => {
  const regex = new RegExp(`${field}=("[^"]*"|[^,]*)`, 'i')
  const match = regex.exec(raw)
  if (match && match[1]) return trim ? match[1].replace(/[\s"]/g, '') : match[1]
  return null
}

interface DigestClient {
  user: string
  password: string
  hashFunc: Function
  nonceRaw: string
  logger: Console
  precomputedHash?: boolean
  digest: Digest
  hasAuth: boolean
  cnonceSize: number
  statusCode?: number | null
  basic: boolean
  lastAuth?: string
}

interface Options {
  method?: string
  headers?: any
  factory?: () => RequestInit
  logger?: Console
  precomputedHash?: boolean
  algorithm?: string
  cnonceSize?: number
  statusCode?: number
  basic?: boolean
}

interface Digest {
  nonce?: string
  cnonce?: string
  qop?: string | null
  opaque?: string | null
  scheme?: string | undefined
  nc: number
  algorithm: string
  realm: string
}

class DigestClient {
  constructor(user: string, password: string, options: Options = {}) {
    this.user = user
    this.hashFunc = md5
    this.password = password
    this.nonceRaw = 'abcdef0123456789'
    this.logger = options.logger ? options.logger : console
    this.precomputedHash =
      options.precomputedHash == undefined ? false : options.precomputedHash

    let algorithm = options.algorithm || 'MD5'
    if (!supported_algorithms.includes(algorithm)) {
      if (this.logger)
        this.logger.warn(
          `Unsupported algorithm ${algorithm}, will try with MD5`
        )
      algorithm = 'MD5'
    }
    if (algorithm.startsWith('SHA-256')) {
      this.hashFunc = sha256
    } else if (algorithm.startsWith('SHA-512-256')) {
      this.hashFunc = sha512_256
    }
    this.digest = { nc: 0, algorithm, realm: '' }
    this.hasAuth = false
    this.cnonceSize =
      typeof options.cnonceSize !== 'undefined' ? options.cnonceSize : 32
    //const _cnonceSize = parseInt(options.cnonceSize)
    //this.cnonceSize = isNaN(_cnonceSize) ? 32 : _cnonceSize // cnonce length 32 as default

    // Custom authentication failure code for avoiding browser prompt:
    // https://stackoverflow.com/questions/9859627/how-to-prevent-browser-to-invoke-basic-auth-popup-and-handle-401-error-using-jqu
    this.statusCode = options.statusCode || null
    this.basic = options.basic || false
  }

  async fetch(url: string, options: Options = {}) {
    if (this.basic) return fetch(url, this.addBasicAuth(options))
    const resp = await fetch(url, this.addAuth(url, options))
    if (
      resp.status == 401 ||
      (resp.status == this.statusCode && this.statusCode)
    ) {
      this.hasAuth = false
      this.parseAuth(resp.headers.get('www-authenticate'))
      if (this.hasAuth) {
        const respFinal = await fetch(url, this.addAuth(url, options))
        if (respFinal.status == 401 || respFinal.status == this.statusCode) {
          this.hasAuth = false
        } else {
          this.digest.nc++
        }
        return respFinal
      }
    } else this.digest.nc++
    return resp
  }

  addBasicAuth(options: Options = {}) {
    const _options: Options =
      typeof options.factory == 'function' ? options.factory() : options

    const auth = 'Basic ' + base64.encode(this.user + ':' + this.password)
    _options.headers = _options.headers || {}
    _options.headers.Authorization = auth
    if (typeof _options.headers.set == 'function') {
      _options.headers.set('Authorization', auth)
    }

    if (this.logger) this.logger.debug(options)
    return _options
  }

  computeHash(user: string, realm: string, password: string) {
    return this.hashWithAlgorithm(`${user}:${realm}:${password}`)
  }

  hashWithAlgorithm(data: string) {
    return this.hashFunc(data)
  }

  addAuth(url: string, options: Options) {
    if (typeof options.factory == 'function') options = options.factory()
    if (!this.hasAuth) return options
    if (this.logger) this.logger.info(`requesting with auth carried`)

    //const isRequest = typeof(url) === 'object' && typeof(url.url) === 'string'
    //const urlStr: string = isRequest ? url.url : url
    const _url = url.replace('//', '')
    const uri = _url.indexOf('/') == -1 ? '/' : _url.slice(_url.indexOf('/'))
    const method = options.method ? options.method.toUpperCase() : 'GET'

    let ha1 = this.precomputedHash
      ? this.password
      : this.computeHash(this.user, this.digest.realm, this.password)
    if (this.digest.algorithm.endsWith('-sess')) {
      ha1 = this.hashWithAlgorithm(
        `${ha1}:${this.digest.nonce}:${this.digest.cnonce}`
      )
    }

    // optional Hash(entityBody) for 'auth-int'
    let _ha2 = ''
    if (this.digest.qop === 'auth-int') {
      // not implemented for auth-int
      if (this.logger)
        this.logger.warn('Sorry, auth-int is not implemented in this plugin')
      // const entityBody = xxx
      // _ha2 = ':' + hash(entityBody)
    }
    const ha2 = this.hashWithAlgorithm(`${method}:${uri}${_ha2}`)

    const ncString = ('00000000' + this.digest.nc).slice(-8)

    let _response = `${ha1}:${this.digest.nonce}:${ncString}:${this.digest.cnonce}:${this.digest.qop}:${ha2}`
    if (!this.digest.qop) _response = `${ha1}:${this.digest.nonce}:${ha2}`
    const response = this.hashWithAlgorithm(_response)

    const opaqueString =
      this.digest.opaque !== null ? `opaque="${this.digest.opaque}",` : ''
    const qopString = this.digest.qop ? `qop=${this.digest.qop},` : ''
    const digest = `${this.digest.scheme} username="${this.user}",realm="${this.digest.realm}",\
nonce="${this.digest.nonce}",uri="${uri}",${opaqueString}${qopString}\
algorithm=${this.digest.algorithm},response="${response}",nc=${ncString},cnonce="${this.digest.cnonce}"`
    options.headers = options.headers || {}
    options.headers.Authorization = digest
    if (typeof options.headers.set == 'function') {
      options.headers.set('Authorization', digest)
    }

    if (this.logger) this.logger.debug(options)

    // const {factory, ..._options} = options
    const _options: Options = {}
    Object.assign(_options, options)
    //Why? delete _options.factory
    return _options
  }

  parseAuth(h: string | null) {
    this.lastAuth = h ? h : ''

    if (!h || h.length < 5) {
      this.hasAuth = false
      return
    }

    this.hasAuth = true

    this.digest.scheme = h.split(/\s/)[0]

    this.digest.realm = (parse(h, 'realm', false) || '').replace(/["]/g, '')

    this.digest.qop = this.parseQop(h)

    this.digest.opaque = parse(h, 'opaque')

    this.digest.nonce = parse(h, 'nonce') || ''

    this.digest.cnonce = this.makeNonce()
    this.digest.nc++
  }

  parseQop(rawAuth: string) {
    // Following https://en.wikipedia.org/wiki/Digest_access_authentication
    // to parse valid qop
    // Samples
    // : qop="auth,auth-init",realm=
    // : qop=auth,realm=
    const _qop = parse(rawAuth, 'qop')

    if (_qop !== null) {
      const qops = _qop.split(',')
      if (qops.includes('auth')) return 'auth'
      else if (qops.includes('auth-int')) return 'auth-int'
    }
    // when not specified
    return null
  }

  makeNonce() {
    let uid = ''
    for (let i = 0; i < this.cnonceSize; ++i) {
      uid += this.nonceRaw[Math.floor(Math.random() * this.nonceRaw.length)]
    }
    return uid
  }

  static parse(...args: [raw: string, field: string]) {
    return parse(...args)
  }
}

module.exports = DigestClient