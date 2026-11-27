import CryptoKit
import Foundation
import LocalAuthentication

// 금고(poc/packages/vault/src/keychain/touchid.ts)가 부르는 보안칩 도우미. 표준 입력으로 JSON 하나를 받고 표준 출력으로 JSON 하나를 낸다.
// available: Touch ID를 지금 쓸 수 있는지(센서, 등록, 덮개). create: 생체 전용 보안칩 키를 만든다. derive: Touch ID를 물은 뒤 ECDH 결과를 낸다.

struct Request: Decodable {
  let op: String
  let key: String?
  let e: String?
  let reason: String?
}

func reply(_ o: [String: Any]) -> Never {
  FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: o))
  exit(0)
}

func biometryReady() -> Bool {
  var err: NSError?
  return SecureEnclave.isAvailable && LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
}

guard let req = try? JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile()) else { reply(["error": "bad_request"]) }

switch req.op {
case "available":
  reply(["available": biometryReady()])
case "create":
  guard biometryReady(),
    let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], nil),
    let key = try? SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
  else { reply(["error": "unavailable"]) }
  reply(["pub": key.publicKey.x963Representation.base64EncodedString(), "key": key.dataRepresentation.base64EncodedString()])
case "derive":
  guard let kb = req.key.flatMap({ Data(base64Encoded: $0) }), let eb = req.e.flatMap({ Data(base64Encoded: $0) }),
    let peer = try? P256.KeyAgreement.PublicKey(x963Representation: eb)
  else { reply(["error": "bad_request"]) }
  let ctx = LAContext()
  ctx.localizedReason = req.reason ?? ""
  do {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: kb, authenticationContext: ctx)
    let z = try key.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
    reply(["z": z.base64EncodedString()])
  } catch let e as LAError where [.userCancel, .appCancel, .systemCancel, .userFallback].contains(e.code) {
    reply(["error": "cancelled"])
  } catch {
    reply(["error": "invalid"])
  }
default:
  reply(["error": "bad_request"])
}
