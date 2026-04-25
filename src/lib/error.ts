export class BridgeNotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BridgeNotImplementedError"
  }
}

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.name = "HTTPError"
    this.response = response
  }
}
