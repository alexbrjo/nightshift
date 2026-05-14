use super::*;

#[test]
fn freeze_files_rewrites_to_content_addressed_paths() {
    let temp = std::env::temp_dir().join(format!("nightshift-method-test-{}", Uuid::new_v4()));
    fs::create_dir_all(temp.join("prompts")).unwrap();
    fs::write(temp.join("prompts/main.jinja2"), "Hello {{name}}").unwrap();
    let dest = temp.join(".nightshift/executions/1/snapshot");
    let mut method = sample_method();

    freeze_files(&mut method, &temp, &dest).unwrap();

    assert!(method.workflow.nodes[0].path.as_deref().unwrap().starts_with("files/"));
    assert!(dest.join(method.workflow.nodes[0].path.as_deref().unwrap()).is_file());
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn method_document_round_trips_through_source_paths() {
    let temp =
        std::env::temp_dir().join(format!("nightshift-method-roundtrip-test-{}", Uuid::new_v4()));
    let draft_path = temp.join("methods/current.method.yaml");
    let saved_path = temp.join("methods/edge.method.yaml");
    fs::create_dir_all(draft_path.parent().unwrap()).unwrap();
    fs::create_dir_all(saved_path.parent().unwrap()).unwrap();
    let method = sample_method();

    write_method_document(&draft_path, &method).unwrap();
    write_method_document(&saved_path, &method).unwrap();

    assert_eq!(read_method_document(&draft_path).unwrap(), method);
    assert_eq!(read_method_document(&saved_path).unwrap(), method);
    assert_eq!(yaml_top_level_keys(&draft_path), yaml_top_level_keys(&saved_path));
    fs::remove_dir_all(temp).unwrap();
}
