import Container from "../../components/Container";
import Code from "../../components/Code";
import Header from "../../components/Header";
import { util } from "../../examples/isThennable";

export default function IsThennableRoute() {
  return (
    <Container>
      <Header title="isThennable" />
      <p>
        "Thennable" are a lower level concept that the caches in this package
        are built on top of.
      </p>
      <p>
        A "thennable" is any object that defines a <code>then</code> method that
        can be used to observe success or failure. (Promises are the most common
        example of this– although you can also implement your own).
      </p>
      <p>
        <code>isThennable</code> can be used to determine if a value is a
        "thennable" or not.
      </p>
      <Code code={util} />
      <p>
        Although this package exports the <code>isThennable</code> API, you
        probably won't need to use it directly in most cases.
      </p>
    </Container>
  );
}
